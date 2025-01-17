const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const QRCode = require('qrcode');

app.use(express.static('public'));

// Add QR code generation endpoint
app.get('/qr', async (req, res) => {
    try {
        const url = req.query.url;
        if (!url) {
            return res.status(400).send('URL parameter is required');
        }
        const qrCode = await QRCode.toDataURL(url);
        res.send(qrCode);
    } catch (error) {
        console.error('QR Code generation error:', error);
        res.status(500).send('Error generating QR code');
    }
});

// Store for multiple sessions
const sessions = new Map();

// Generate random room code
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Message structure: { id: string, text: string, timestamp: number }
function createMessage(text) {
    return {
        id: Math.random().toString(36).substring(2, 15),
        text: text,
        timestamp: Date.now()
    };
}

const PORT = process.env.PORT || 3000;

io.on('connection', (socket) => {
    console.log('User connected');
    
    // Create new session (admin only)
    socket.on('createSession', async () => {
        const roomCode = generateRoomCode();
        
        sessions.set(roomCode, {
            ratings: [],
            pageTitle: 'Rating Session',
            isVotingActive: true,
            isMessageBoardActive: false,
            messages: [],
            adminSocket: socket.id
        });
        
        socket.join(roomCode);
        socket.emit('sessionCreated', { roomCode });
    });

    // Message board controls (admin only)
    socket.on('toggleMessageBoard', ({ roomCode, enabled }) => {
        const session = sessions.get(roomCode);
        if (session && session.adminSocket === socket.id) {
            session.isMessageBoardActive = enabled;
            io.to(roomCode).emit('messageBoardStatus', enabled);
        }
    });

    socket.on('clearMessages', (roomCode) => {
        const session = sessions.get(roomCode);
        if (session && session.adminSocket === socket.id) {
            session.messages = [];
            io.to(roomCode).emit('messagesUpdated', []);
        }
    });

    socket.on('deleteMessage', ({ roomCode, messageId }) => {
        const session = sessions.get(roomCode);
        if (session && session.adminSocket === socket.id) {
            session.messages = session.messages.filter(m => m.id !== messageId);
            io.to(roomCode).emit('messagesUpdated', session.messages);
        }
    });

    // Handle new messages from users
    socket.on('sendMessage', ({ roomCode, text }) => {
        const session = sessions.get(roomCode);
        if (session && session.isMessageBoardActive) {
            const message = createMessage(text);
            session.messages.push(message);
            io.to(roomCode).emit('messagesUpdated', session.messages);
        }
    });

    // Join existing session (users)
    socket.on('joinSession', (roomCode) => {
        const session = sessions.get(roomCode);
        if (session) {
            socket.join(roomCode);
            socket.roomCode = roomCode;
            socket.emit('joinedSession', {
                pageTitle: session.pageTitle,
                ratings: session.ratings,
                average: calculateAverage(session.ratings),
                totalVotes: session.ratings.length,
                isMessageBoardActive: session.isMessageBoardActive,
                messages: session.messages
            });
            // Update connected users count for admin
            io.to(roomCode).emit('updateConnections', 
                io.sockets.adapter.rooms.get(roomCode).size);
        } else {
            socket.emit('error', 'Invalid room code');
        }
    });

    // Handle voting
    socket.on('submitVote', (data) => {
        const { roomCode, rating } = data;
        const session = sessions.get(roomCode);
        
        console.log('Vote attempt:', {
            roomCode,
            rating,
            isVotingActive: session?.isVotingActive,
            hasVoted: session?.ratings.some(r => r.socketId === socket.id)
        });
        
        if (session && session.isVotingActive && 
            !session.ratings.find(r => r.socketId === socket.id)) {
            session.ratings.push({
                socketId: socket.id,
                rating: rating
            });
            
            console.log(`New vote in room ${roomCode}: ${rating}`);
            io.to(roomCode).emit('updateVotes', {
                ratings: session.ratings,
                average: calculateAverage(session.ratings),
                totalVotes: session.ratings.length
            });
        }
    });

    // Handle admin commands
    socket.on('startNewVoting', (roomCode) => {
        const session = sessions.get(roomCode);
        if (session && session.adminSocket === socket.id) {
            session.ratings = [];
            session.isVotingActive = true;
            console.log(`Starting new voting session in room ${roomCode}`);
            io.to(roomCode).emit('votingStarted');
            io.to(roomCode).emit('updateVotes', {
                ratings: session.ratings,
                average: 0,
                totalVotes: 0
            });
        }
    });

    socket.on('updateTitle', (data) => {
        const { roomCode, newTitle } = data;
        const session = sessions.get(roomCode);
        if (session && session.adminSocket === socket.id) {
            session.pageTitle = newTitle || 'Rating Session'; // Default title if empty
            console.log(`Updating title to "${session.pageTitle}" for room ${roomCode}`);
            io.to(roomCode).emit('updateTitle', session.pageTitle);
        }
    });

    socket.on('disconnect', () => {
        if (socket.roomCode) {
            const session = sessions.get(socket.roomCode);
            if (session) {
                // Remove user's vote if they disconnect
                session.ratings = session.ratings.filter(r => r.socketId !== socket.id);
                
                // Update remaining clients
                io.to(socket.roomCode).emit('updateVotes', {
                    ratings: session.ratings,
                    average: calculateAverage(session.ratings),
                    totalVotes: session.ratings.length
                });

                // Update connected users count
                const room = io.sockets.adapter.rooms.get(socket.roomCode);
                if (room) {
                    io.to(socket.roomCode).emit('updateConnections', room.size);
                }

                // Clean up session if admin disconnects
                if (session.adminSocket === socket.id) {
                    io.to(socket.roomCode).emit('sessionEnded');
                    sessions.delete(socket.roomCode);
                }
            }
        }
    });

    socket.on('leaveRoom', (roomCode) => {
        if (roomCode) {
            socket.leave(roomCode);
            const session = sessions.get(roomCode);
            if (session) {
                // Remove user's vote if they leave
                session.ratings = session.ratings.filter(r => r.socketId !== socket.id);
                
                // Update remaining clients
                io.to(roomCode).emit('updateVotes', {
                    ratings: session.ratings,
                    average: calculateAverage(session.ratings),
                    totalVotes: session.ratings.length
                });

                // Update connected users count
                const room = io.sockets.adapter.rooms.get(roomCode);
                if (room) {
                    io.to(roomCode).emit('updateConnections', room.size);
                }
            }
        }
    });
});

function calculateAverage(ratings) {
    if (ratings.length === 0) return 0;
    const sum = ratings.reduce((acc, curr) => acc + curr.rating, 0);
    return (sum / ratings.length).toFixed(2);
}

http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 
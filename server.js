const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

// Create Socket.IO server with CORS configuration
const io = new Server(server, {
    cors: {
      // Add your Vercel domain to the allowed origins
      origin: ["https://bidzyy.vercel.app", "http://localhost:3000"],
      methods: ["GET", "POST"],
      credentials: true
    }
  });

// Store auctions and their data
const auctions = {};

// Socket.IO connection handling
io.on('connection', (socket) => {
  const userId = socket.handshake.query.userId || 'anonymous';
  const username = socket.handshake.query.username || `User-${socket.id.slice(0, 5)}`;
  console.log(`User connected: ${username} (${userId})`);

  // Join an auction room
  socket.on('join_auction', ({ auctionId }) => {
    console.log(`Socket connection established for auction: ${auctionId}`);
    socket.join(auctionId);

    // Initialize auction if it doesn't exist
    if (!auctions[auctionId]) {
      auctions[auctionId] = {
        id: auctionId,
        currentBid: 1000, // Starting bid
        leaderboard: [],
        timeRemaining: 1800, // 30 minutes in seconds
        participants: {},
        isActive: true,
        bidCooldown: 30, // 30 second cooldown
        lastBidTime: Date.now(),
        cooldownActive: false
      };
    }

    // Add user to participants
    auctions[auctionId].participants[socket.id] = { userId, username };

    // Count active unique users (by userId, not socket.id)
    const uniqueUserIds = new Set(
      Object.values(auctions[auctionId].participants).map((p) => p.userId)
    );
    const activeUsers = uniqueUserIds.size;

    // Send current auction state to new participant
    socket.emit('auction_update', {
      auctionId,
      currentBid: auctions[auctionId].currentBid,
      leaderboard: auctions[auctionId].leaderboard,
      timeRemaining: auctions[auctionId].timeRemaining,
      activeUsers,
      cooldownRemaining: auctions[auctionId].cooldownActive ? 
        Math.max(0, auctions[auctionId].bidCooldown - Math.floor((Date.now() - auctions[auctionId].lastBidTime) / 1000)) : 0
    });

    // Notify everyone about updated user count
    io.to(auctionId).emit('user_count_update', { 
      auctionId, 
      activeUsers
    });
  });

  // Leave an auction
  socket.on('leave_auction', ({ auctionId }) => {
    socket.leave(auctionId);
    
    if (auctions[auctionId] && auctions[auctionId].participants[socket.id]) {
      delete auctions[auctionId].participants[socket.id];
      
      // Count active unique users
      const uniqueUserIds = new Set(
        Object.values(auctions[auctionId].participants).map((p) => p.userId)
      );
      const activeUsers = uniqueUserIds.size;
      
      io.to(auctionId).emit('user_count_update', { 
        auctionId, 
        activeUsers
      });
    }
  });

  // Place a bid
  socket.on('place_bid', ({ auctionId, bid }) => {
    if (!auctions[auctionId] || !auctions[auctionId].isActive) {
      socket.emit('bid_error', { message: 'Auction is not active' });
      return;
    }

    console.log(`Bid received for auction ${auctionId}:`, bid);
    
    // Add timestamp if not provided
    if (!bid.timestamp) {
      bid.timestamp = new Date();
    }
    
    // Add bid to leaderboard
    auctions[auctionId].leaderboard.push(bid);
    
    // Sort leaderboard (ascending for reverse auction - lowest first)
    auctions[auctionId].leaderboard.sort((a, b) => a.amount - b.amount);
    
    // Limit leaderboard size
    if (auctions[auctionId].leaderboard.length > 10) {
      auctions[auctionId].leaderboard = auctions[auctionId].leaderboard.slice(0, 10);
    }
    
    // Update current bid
    auctions[auctionId].currentBid = auctions[auctionId].leaderboard[0].amount;
    
    // Reset cooldown timer
    auctions[auctionId].lastBidTime = Date.now();
    auctions[auctionId].cooldownActive = true;
    
    // Count active unique users
    const uniqueUserIds = new Set(
      Object.values(auctions[auctionId].participants).map((p) => p.userId)
    );
    const activeUsers = uniqueUserIds.size;
    
    // Emit new bid to all participants
    io.to(auctionId).emit('new_bid', { 
      auctionId, 
      bid, 
      cooldownRemaining: auctions[auctionId].bidCooldown 
    });
    
    // Send updated auction state
    io.to(auctionId).emit('auction_update', {
      auctionId,
      currentBid: auctions[auctionId].currentBid,
      leaderboard: auctions[auctionId].leaderboard,
      timeRemaining: auctions[auctionId].timeRemaining,
      activeUsers,
      cooldownRemaining: auctions[auctionId].bidCooldown
    });
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${username} (${userId})`);
    
    // Remove user from all auctions they were in
    Object.keys(auctions).forEach(auctionId => {
      if (auctions[auctionId].participants[socket.id]) {
        delete auctions[auctionId].participants[socket.id];
        
        // Count active unique users
        const uniqueUserIds = new Set(
          Object.values(auctions[auctionId].participants).map((p) => p.userId)
        );
        const activeUsers = uniqueUserIds.size;
        
        io.to(auctionId).emit('user_count_update', { 
          auctionId, 
          activeUsers
        });
      }
    });
  });
});

// Auction timer and bid cooldown
setInterval(() => {
  Object.keys(auctions).forEach(auctionId => {
    const auction = auctions[auctionId];
    
    if (auction.isActive) {
      // Process auction main timer
      if (auction.timeRemaining > 0) {
        auction.timeRemaining--;
      }
      
      // Process bid cooldown timer
      if (auction.cooldownActive) {
        const elapsedSinceLastBid = Math.floor((Date.now() - auction.lastBidTime) / 1000);
        const cooldownRemaining = Math.max(0, auction.bidCooldown - elapsedSinceLastBid);
        
        // If cooldown expired, end auction
        if (cooldownRemaining === 0) {
          console.log(`Auction ${auctionId} ended due to bid cooldown expiration`);
          auction.isActive = false;
          
          const winner = auction.leaderboard.length > 0 ? auction.leaderboard[0] : null;
          
          io.to(auctionId).emit('auction_ended', {
            auctionId,
            winner,
            reason: 'cooldown'
          });
          
          return;
        }
        
        // Every second, update cooldown timer
        io.to(auctionId).emit('cooldown_update', {
          auctionId,
          cooldownRemaining
        });
      }
      
      // Send time update every 5 seconds to reduce network traffic
      if (auction.timeRemaining % 5 === 0) {
        // Count active unique users
        const uniqueUserIds = new Set(
          Object.values(auction.participants).map((p) => p.userId)
        );
        const activeUsers = uniqueUserIds.size;
        
        io.to(auctionId).emit('auction_update', {
          auctionId,
          timeRemaining: auction.timeRemaining,
          currentBid: auction.currentBid,
          leaderboard: auction.leaderboard,
          activeUsers,
          cooldownRemaining: auction.cooldownActive ? 
            Math.max(0, auction.bidCooldown - Math.floor((Date.now() - auction.lastBidTime) / 1000)) : 0
        });
      }
      
      // End auction when time runs out
      if (auction.timeRemaining <= 0) {
        auction.isActive = false;
        
        const winner = auction.leaderboard.length > 0 ? auction.leaderboard[0] : null;
        
        io.to(auctionId).emit('auction_ended', {
          auctionId,
          winner,
          reason: 'timeout'
        });
        
        console.log(`Auction ${auctionId} ended due to time expiration. Winner: ${winner ? winner.username : 'No bids'}`);
      }
    }
  });
}, 1000);

// Add a simple health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', auctions: Object.keys(auctions).length });
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});

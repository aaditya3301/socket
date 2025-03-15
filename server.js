const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// Initialize Express app
const app = express();
app.use(cors());
const server = http.createServer(app);

// Socket.IO server with CORS configuration
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000", "https://bidzy.vercel.app"],
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["*"]
  }
});

// Store auctions and their data
const auctions = {};

// Socket.IO connection handling
io.on('connection', (socket) => {
  const userId = socket.handshake.query.userId || socket.id;
  const username = socket.handshake.query.username || `User-${socket.id.slice(0, 5)}`;
  
  console.log(`User connected: ${username} (${userId})`);

  // Handle heartbeat to keep connection alive
  socket.on('heartbeat', () => {
    socket.emit('heartbeat_response');
  });

  // Join an auction room
  socket.on('join_auction', ({ auctionId }) => {
    console.log(`Socket connection established for auction: ${auctionId} by ${username}`);
    socket.join(auctionId);

    // Initialize auction if it doesn't exist
    if (!auctions[auctionId]) {
      auctions[auctionId] = {
        id: auctionId,
        currentBid: 1000, // Starting bid
        leaderboard: [],
        timeRemaining: 1800, // 30 minutes in seconds
        participants: {},
        isActive: false, // Start as inactive until countdown completes
        bidCooldown: 30, // 30 second cooldown
        lastBidTime: Date.now(),
        cooldownActive: false,
        startTime: Date.now(),
        startCountdown: 30 // 30 second countdown before auction starts
      };
    }

    // Add user to participants with their actual userId (not socket.id)
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
        Math.max(0, auctions[auctionId].bidCooldown - Math.floor((Date.now() - auctions[auctionId].lastBidTime) / 1000)) : 0,
      startCountdown: auctions[auctionId].startCountdown,
      isActive: auctions[auctionId].isActive
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
      
      // Count active unique users by userId, not socket.id
      const uniqueUserIds = new Set(
        Object.values(auctions[auctionId].participants).map((p) => p.userId)
      );
      const activeUsers = uniqueUserIds.size;
      
      io.to(auctionId).emit('user_count_update', { 
        auctionId, 
        activeUsers
      });
      
      console.log(`User ${username} left auction ${auctionId}. ${activeUsers} users remaining.`);
    }
  });

  // Place a bid
  socket.on('place_bid', ({ auctionId, bid }) => {
    if (!auctions[auctionId] || !auctions[auctionId].isActive) {
      socket.emit('bid_error', { message: 'Auction is not active' });
      return;
    }

    // Verify bid structure
    if (!bid || !bid.amount || typeof bid.amount !== 'number') {
      socket.emit('bid_error', { message: 'Invalid bid format' });
      return;
    }

    // For reverse auction, bid must be LOWER than current bid
    if (auctions[auctionId].leaderboard.length > 0 && 
        bid.amount >= auctions[auctionId].currentBid) {
      socket.emit('bid_error', { 
        message: `Your bid must be lower than the current lowest bid of $${auctions[auctionId].currentBid}` 
      });
      return;
    }

    console.log(`Bid received for auction ${auctionId}: $${bid.amount} from ${bid.username || username}`);
    
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
      cooldownRemaining: auctions[auctionId].bidCooldown,
      startCountdown: auctions[auctionId].startCountdown,
      isActive: auctions[auctionId].isActive
    });
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${username} (${userId})`);
    
    // Remove user from all auctions they were in
    Object.keys(auctions).forEach(auctionId => {
      if (auctions[auctionId].participants[socket.id]) {
        delete auctions[auctionId].participants[socket.id];
        
        // Count active unique users by userId, not socket.id
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
    
    // Process auction start countdown if not active
    if (!auction.isActive && auction.startCountdown > 0) {
      auction.startCountdown--;
      
      // Notify clients of countdown
      io.to(auctionId).emit('start_countdown_update', {
        auctionId,
        startCountdown: auction.startCountdown
      });
      
      // If countdown reaches zero, activate the auction
      if (auction.startCountdown === 0) {
        auction.isActive = true;
        io.to(auctionId).emit('auction_started', {
          auctionId
        });
      }
    }
    
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
            Math.max(0, auction.bidCooldown - Math.floor((Date.now() - auction.lastBidTime) / 1000)) : 0,
          startCountdown: auction.startCountdown,
          isActive: auction.isActive
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

// Auction stats and cleanup (run every hour)
setInterval(() => {
  const now = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  
  // Clean up completed auctions older than 1 day
  Object.keys(auctions).forEach(auctionId => {
    const auction = auctions[auctionId];
    if (!auction.isActive && (now - auction.startTime > ONE_DAY_MS)) {
      delete auctions[auctionId];
      console.log(`Cleaned up old auction: ${auctionId}`);
    }
  });
  
  // Log active auctions stats
  const activeCount = Object.values(auctions).filter(a => a.isActive).length;
  const totalCount = Object.keys(auctions).length;
  console.log(`Auctions: ${activeCount} active, ${totalCount} total`);
}, 60 * 60 * 1000); // Every hour

// API endpoints for status checking
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok',
    uptime: process.uptime(),
    auctions: Object.keys(auctions).length,
    activeAuctions: Object.values(auctions).filter(a => a.isActive).length
  });
});

app.get('/auctions', (req, res) => {
  // Return a summary of all auctions (not full data for privacy)
  const auctionSummary = Object.entries(auctions).map(([id, auction]) => ({
    id,
    currentBid: auction.currentBid,
    timeRemaining: auction.timeRemaining,
    isActive: auction.isActive,
    participants: Object.keys(auction.participants).length,
    bids: auction.leaderboard.length,
    startCountdown: auction.startCountdown
  }));
  
  res.status(200).json(auctionSummary);
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});

// Handle server shutdown gracefully
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

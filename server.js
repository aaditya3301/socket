// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // Allow all origins (replace with your Vercel frontend URL in production)
    methods: ['GET', 'POST'],
  },
});

// Track active auctions and bids
const activeAuctions = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join a specific auction room
  socket.on('join_auction', (auctionId) => {
    socket.join(auctionId);
    if (!activeAuctions.has(auctionId)) {
      activeAuctions.set(auctionId, {
        currentBid: 0,
        highestBidder: null,
        bids: [],
      });
    }
    // Send current state to the new user
    socket.emit('auction_state', activeAuctions.get(auctionId));
  });

  // Handle new bids
  socket.on('place_bid', ({ auctionId, userId, bidAmount }) => {
    const auction = activeAuctions.get(auctionId);
    if (bidAmount > auction.currentBid) {
      auction.currentBid = bidAmount;
      auction.highestBidder = userId;
      auction.bids.push({ userId, bidAmount, timestamp: Date.now() });

      // Broadcast the new bid to all users in the auction room
      io.to(auctionId).emit('bid_update', {
        currentBid: bidAmount,
        highestBidder: userId,
      });
    } else {
      // Notify the user their bid is too low
      socket.emit('bid_error', 'Bid amount must be higher than current bid');
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Socket.io server running on port ${PORT}`);
});


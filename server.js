const express = require('express');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const cookie = require('cookie');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GitHubStrategy = require('passport-github').Strategy;
const crypto = require('crypto');
const io = require('socket.io');
const generateName = require('sillyname');

const passportConfig = require('./config');
const db = require('./db/queries.js');
const game = require('./utils.js');

const secret = 'Express is awesome!'; // used to sign cookies
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret,
  resave: false,
  saveUninitialized: true,
}));

app.use(passport.initialize());
app.use(passport.session());
app.use(express.static('public'));
app.use(cookieParser(secret));


require('./routes/routes.js')(app);


passport.use(new GitHubStrategy(passportConfig, (accessToken, refreshToken, profile, cb) => {
  return cb(null, profile);
}));

passport.use(new LocalStrategy((username, password, done) => {
  db.getUserByEmail(username, (err, user) => {
    if (err) {
      return done(null, false);
    }

    if (!user) {
      return done(null, false);
    }

    return crypto.pbkdf2(password, secret, 1000, 128, 'sha256', (error, derivedKey) => {
      if (!error && derivedKey.toString('hex') === user[0].password_hash) {
        return done(null, user);
      }
      return done(null, false);
    });
  });
}));

passport.serializeUser((user, cb) => {
  cb(null, user);
});

passport.deserializeUser((user, cb) => {
  cb(null, user);
});


app.listen(3000, console.log('Listening on port 3000.'));


// ============================================================= //
// ====== handle communication channels with clients =========== //
// ============================================================= //


let matrix = game.generateMatrix(3, 3);
const server = io.listen(8000);
let currentMoveIsX = true;
let movesCount = 0;


const updateMatrix = ([rowIndex, colIndex], clientSelection) => {
  matrix[rowIndex][colIndex] = clientSelection;
};

const roomIsFull = (room) => {
  return Boolean(room.playerTwo.name);
};

const assignName = (user) => {
  return user.username || user.github_username || generateName();
};

let rooms = [];

const createNewRoom = (roomName, roomId, playerName) => {
  const room = {
    name: roomName,
    id: roomId,
    playerOne: {
      name: playerName,
      score: 0,
    },
    playerTwo: {
      name: '',
      score: 0,
    },
  };

  return room;
};

const findRoom = (roomName) => {
  return rooms.filter(room => room.name === roomName)[0];
};

const deleteRoom = (roomName) => {
  rooms = rooms.filter(room => room.id !== roomName);
};

const resetGame = () => {
  matrix = game.generateMatrix(3, 3);
  movesCount = 0;
};

const getRoomById = (roomId) => {
  return rooms.filter(room => room.id === roomId)[0];
};

const filterRooms = (roomId) => {
  return rooms.filter(room => room.id !== roomId);
};

server.on('connection', (socket) => {
  socket.emit('display existing rooms', rooms);
  socket.broadcast.emit('display existing rooms', rooms);

  const { token } = cookie.parse(socket.handshake.headers.cookie);

  // validate if token is valid
  if (!token) {
    console.log('TOKEN NOT FOUND!');
  }

  let currentUser;
  db.getUserByToken(token, (err, result) => {
    [currentUser] = result;

    db.getScores((err2, scoresList) => {
      let rank = 0;

      scoresList.forEach((item) => {
        if (item.score >= currentUser.score) {
          rank += 1;
        }
      });

      currentUser.rank = rank;
      socket.emit('user stats on connection', currentUser);
    });
  });


  socket.on('new room', (roomNameOptionalInput) => {
    const randomRoomName = crypto.randomBytes(4).toString('hex');
    const roomName = roomNameOptionalInput || randomRoomName;
    const playerName = assignName(currentUser);
    const roomId = socket.id;
    const newRoom = createNewRoom(roomName, roomId, playerName);

    rooms.push(newRoom);

    socket.join(newRoom.name);
    socket.emit('wait player 2', 'Waiting for the second player to join.');
    socket.emit('update user stats', currentUser, newRoom.name);
    socket.emit('display leave room button');
    socket.broadcast.emit('display existing rooms', rooms);
  });


  socket.on('join room', (roomName) => {
    const room = findRoom(roomName);
    deleteRoom(roomName);
    socket.broadcast.emit('display existing rooms', rooms);

    if (roomIsFull(room)) {
      socket.emit('message', 'The room is full!');
    } else {
      socket.join(room.name);
      room.playerTwo.name = assignName(currentUser);
      socket.broadcast.to(room.id).emit('start game', matrix);
      socket.emit('start game', matrix);

      socket.broadcast.to(room.id).emit('message', 'your first move');
      socket.emit('freeze game', 'wait for player one\'s first move');
      socket.emit('update user stats', currentUser, room.id);
      socket.emit('display leave room button');
    }
  });


  socket.on('game input', (cellIndex, roomName) => {
    movesCount += 1;
    const cellValue = currentMoveIsX ? 'X' : '0'; // determine what the current cellValue is
    updateMatrix(cellIndex, cellValue);
    currentMoveIsX = !currentMoveIsX;

    socket.emit('update game', cellIndex, cellValue);
    socket.emit('freeze game', 'wait a second...');
    socket.broadcast.to(roomName).emit('update game', cellIndex, cellValue);
    socket.broadcast.to(roomName).emit('unfreeze game', 'It\'s your turn!');

    if (game.checkWinner(matrix, cellIndex, cellValue)) {
      socket.broadcast.to(roomName).emit('game over', 'You lost!');
      socket.emit('game over', 'Congratulations! You won.');

      currentUser.score += 1;

      db.updateScore(currentUser.score, currentUser.user_id);
      socket.emit('update score', currentUser.score);

      db.getUsernamesAndScores((error, result) => {
        const users = [];
        result.forEach(((user) => {
          users.push({ name: user.username, score: user.score });
        }));
      });

      resetGame();
    } else if (movesCount === 9) {
      socket.broadcast.to(roomName).emit('game over', 'It\'s a tie. Nobody won!');
      socket.emit('game over', 'It\'s a tie. Nobody won!');

      resetGame();
    }
  });


  socket.on('disconnect', () => {
    const room = getRoomById(socket.id);

    if (room) {
      rooms = filterRooms(room.id);
    }

    socket.broadcast.emit('display existing rooms', rooms);
    console.log(`disconnected from: ${socket.id}`);
  });


  socket.on('initiate rematch', (playerName, roomName) => {
    socket.emit('start game', matrix);
    socket.emit('freeze game', 'Rematch ininitiaded. Wait for the opponent to accept.');

    socket.broadcast.to(roomName).emit('message', `${playerName} initiated a rematch. Do you accept?`);
    socket.broadcast.to(roomName).emit('rematch was initiated');

    resetGame();
  });


  socket.on('accept rematch', (roomName) => {
    socket.emit('start game', matrix);
    socket.emit('freeze game', 'wait for the other player\'s first move');

    socket.broadcast.to(roomName).emit('unfreeze game', 'Rematch accepted. Have your first move!');
  });


  socket.on('leave room', (roomName) => {
    socket.emit('display existing rooms', rooms);

    const room = getRoomById(socket.id);
    if (room) {
      socket.broadcast.to(room.id).emit('display existing rooms', rooms);
      socket.broadcast.to(room.id).emit('message', 'Player left the room!');
    }

    deleteRoom(roomName);
    resetGame();
  });


  const standardInput = process.stdin;
  standardInput.setEncoding('utf-8');
  standardInput.on('data', (data) => {
    if (data === 'exit\n') {
      process.exit();
    } else {
      socket.broadcast.emit('message', data); // broadcast the message to everyone except the sender
      socket.emit('message', { matrix }); // broadcast the message to sender
    }
  });

  console.log(`${socket.id} has connected.`);
});

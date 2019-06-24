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
app.use(express.urlencoded());

app.use(session({
  secret,
  resave: false,
  saveUninitialized: true,
}));

app.use(passport.initialize());
app.use(passport.session());
app.use(express.static('public'));
app.use(cookieParser(secret));


require('./routes/index.js')(app);


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
      if (!error && derivedKey.toString('hex') === user[0].password) {
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


app.listen(3000);


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

const rooms = [];

const createNewRoom = (roomName, user) => {
  const room = {
    id: roomName,
    playerOne: {
      name: assignName(user),
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
  let result;
  rooms.forEach((room) => {
    if (room.id === roomName) {
      result = room;
    }
  });

  return result;
};


server.on('connection', (socket) => {
  const { token } = cookie.parse(socket.handshake.headers.cookie);

  // validate if token is valid
  if (!token) {
    // disconnect
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


  const playerId = socket.id;

  socket.on('new room', (roomNameParam) => {
    const roomName = roomNameParam || socket.id;
    const newRoom = createNewRoom(roomName, currentUser);
    rooms.push(newRoom);

    socket.join(newRoom.id);
    socket.emit('wait player 2', 'Waiting for the second player to join.');
    socket.emit('update user stats', currentUser, newRoom.id);
    socket.broadcast.emit('room created', newRoom.id);
  });

  socket.on('join room', (roomName) => {
    const room = findRoom(roomName);

    if (roomIsFull(room)) {
      socket.emit('the room is full');
    } else {
      socket.join(room.id);
      room.playerTwo.name = assignName(currentUser);
      socket.broadcast.to(room.id).emit('start game', matrix);
      socket.emit('start game', matrix);

      socket.broadcast.to(room.id).emit('message', 'your first move');
      socket.emit('freeze game', 'wait for player one\'s first move');
      socket.emit('update user stats', currentUser, room.id);
    }
  });


  socket.on('game input', (cellIndex, roomName) => {
    movesCount += 1;
    // determine what the current cellValue is and update the matrix with it
    const cellValue = currentMoveIsX ? 'X' : '0';
    updateMatrix(cellIndex, cellValue);
    currentMoveIsX = !currentMoveIsX;

    const room = findRoom(roomName);

    socket.emit('update game', cellIndex, cellValue); // broadcast message back to sender
    socket.emit('freeze game', 'wait a second...');
    socket.broadcast.to(room.id).emit('update game', cellIndex, cellValue); // broadcast message to everyone except the sender
    socket.broadcast.to(room.id).emit('unfreeze game', 'It\'s your turn!');

    if (game.checkWinner(matrix, cellIndex, cellValue)) {
      socket.broadcast.to(room.id).emit('game over', 'You lost!');
      socket.emit('game over', 'Congratulations! You won.');

      const currentScore = currentUser.score + 1;

      if (currentScore && currentUser.user_id) {
        db.updateScore(currentScore, currentUser.user_id);
        socket.emit('update score', currentScore);
      } else {
        console.log('Couldn\'t update score: ', currentScore, currentUser.user_id);
      }

      db.getUsernamesAndScores((error, result) => {
        const users = [];
        result.forEach(((user) => {
          users.push({ name: user.username, score: user.score });
        }));
      });
    } else if (movesCount === 9) {
      socket.broadcast.to(room.id).emit('game over', 'It\'s a tie. Nobody won!');
      socket.emit('game over', 'It\'s a tie. Nobody won!');
    }
  });

  socket.on('disconnect', () => {
    console.log(`disconnected from: ${playerId}`);
    socket.broadcast.emit('message', `${playerId} was disconnected.`);
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

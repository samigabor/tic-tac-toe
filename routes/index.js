const path = require('path');
const passport = require('passport');
const crypto = require('crypto');
const db = require('../db/queries.js');

const secret = 'Express is awesome!';

function ensureAuthMiddleware(req, res, next) {
  const { token } = req.cookies; // retrive the token from cookies
  if (!token) {
    return res.redirect('/login');
  }

  db.searchToken(token, (err, result) => { // result will have data from both tables(users & tokens)
    if (err) {
      return res.redirect('/failed');
    }
    // TODO: handle result for both: local and GitHub strategies
    // if (result[0] && token === result[0].token) {
    //   // if found, query for user and store on req.user and call next() --> stored by passport-local
    //   next();
    // }
    next();
  });
}

module.exports = (app) => {
  app.get('/', ensureAuthMiddleware, (req, res) => {
    res.sendFile(path.join(__dirname, '../views/index.html')); // [, dataforview]
  });

  app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, '../views/login.html'));
  });

  app.get('/failed', (req, res) => {
    res.send('<h2>Username and/or password are incorrect</h2>');
  });


  app.get('/logout', (req, res) => {
    res.clearCookie('token');
    req.logout();
    res.redirect('/login');
  });

  app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, '../views/register.html'));
  });

  app.get('/ranking', (req, res) => {
    res.sendFile(path.join(__dirname, '../views/ranking.html'));
  });

  app.get('/users', (req, res) => {
    db.getUsernamesAndScores((err, result) => {
      res.json(result);
    });
  });


  app.get('/login-github',
    (req, res, next) => {
      next(); // optional middleware
    },
    passport.authenticate('github')); // username gets assigned to req.user(the session clears when the server restarts)

  app.get('/auth', passport.authenticate('github', { failureRedirect: '/failed' }),
    (req, res) => {
      const token = crypto.randomBytes(128).toString('hex');
      res.cookie('token', token); // store token to cookies
      res.redirect('/');
    });


  app.post('/login-local',
    passport.authenticate('local', { failureRedirect: '/failed' }),
    (req, res) => { // req.user --> array of RowDataPacket
      const token = crypto.randomBytes(128).toString('hex');
      db.storeToken(token, req.user[0].id);
      res.cookie('token', token); // store token to cookies
      res.redirect('/');
    });


  app.post('/register-local', (req, res) => {
    const hash = crypto.pbkdf2Sync(req.body.password, secret, 1000, 128, 'sha256').toString('hex');

    db.storeUserData(req.body.username, hash, req.body.email);

    res.redirect('/login');
  });
};

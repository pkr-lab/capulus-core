const path = require('path');
const express = require('express');

const adminRouter = require('./routes/admin');
const apiRouter = require('./routes/api');
const { icon } = require('./lib/icons');
const { userFromHeaders } = require('./lib/authentik');

const app = express();
const port = process.env.PORT || 3000;
const adminGroup = process.env.AUTHENTIK_ADMIN_GROUP || 'authentik Admins';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.disable('x-powered-by');
app.locals.icon = icon;
app.locals.adminGroup = adminGroup;

app.use((req, res, next) => {
  res.locals.user = userFromHeaders(req);
  next();
});

app.get('/healthz', (req, res) => res.send('ok'));

app.use('/api', apiRouter);
app.use('/', adminRouter);

app.use((req, res) => {
  res.status(404).send('Nicht gefunden');
});

app.listen(port, () => {
  console.log(`le-homeserver-ui listening on :${port}`);
});

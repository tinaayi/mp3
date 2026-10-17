/*
 * Connect all of your endpoints together here.
 */
module.exports = function (app, router) {
    app.use('/api', require('./home.js')(router)); // home become /api
    app.use('/api', require('./users.js')(router)); // users become /api/users
    app.use('/api', require('./tasks.js')(router)); // tasks become /api/tasks
};

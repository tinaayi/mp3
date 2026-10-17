// Load required packages
var mongoose = require('mongoose');
var User = require('../models/user');
var Task = require('../models/task');

module.exports = function (router) {

    // build route
    var usersRoute = router.route('/users');
    var userRoute = router.route('/users/:id');


    // ==================================================================
    // GET (support where/sort/select/skip/limit/count)
    usersRoute.get(async function (req, res) {
        try {
            var where = {};
            var sort = {};
            var select = null;

            // Parse JSON query parameters
            try {
                if (req.query.where !== undefined) {
                    where = JSON.parse(req.query.where);
                }

                if (req.query.sort !== undefined) {
                    sort = JSON.parse(req.query.sort);
                }

                if (req.query.select !== undefined) {
                    select = JSON.parse(req.query.select);
                }
            } catch (err) {
                return res.status(400).json({
                    message: 'Invalid JSON query parameter.',
                    data: null
                });
            }

            // default skip 0
            var skip = 0;

            if (req.query.skip !== undefined) {
                skip = Number(req.query.skip);

                if (!Number.isInteger(skip) || skip < 0) {
                    return res.status(400).json({
                        message: 'skip must be a non-negative integer.',
                        data: null
                    });
                }
            }

            // Users have no default limit
            var limit = null;

            if (req.query.limit !== undefined) {
                limit = Number(req.query.limit);

                if (!Number.isInteger(limit) || limit < 0) {
                    return res.status(400).json({
                        message: 'limit must be a non-negative integer.',
                        data: null
                    });
                }
            }

            // count=true
            if (req.query.count === 'true') {
                var countQuery = User.countDocuments(where);

                if (skip > 0) {
                    countQuery = countQuery.skip(skip);
                }

                if (limit !== null) {
                    countQuery = countQuery.limit(limit);
                }

                var count = await countQuery.exec();

                return res.status(200).json({
                    message: 'OK',
                    data: count
                });
            }

            // Normal query
            var query = User.find(where);

            query = query.sort(sort);

            if (select !== null) {
                query = query.select(select);
            }

            if (skip > 0) {
                query = query.skip(skip);
            }

            if (limit !== null) {
                query = query.limit(limit);
            }

            var users = await query.exec();

            return res.status(200).json({
                message: 'OK',
                data: users
            });

        } catch (err) {
            console.error(err);

            return res.status(500).json({
                message: 'Internal server error.',
                data: null
            });
        }
    });


    // ==================================================================
    // POST
    usersRoute.post(async function (req, res) {
        var session = await mongoose.startSession();

        try {
            session.startTransaction();

            // Required fields
            if (
                typeof req.body.name !== 'string' ||
                req.body.name.trim() === '' ||
                typeof req.body.email !== 'string' ||
                req.body.email.trim() === ''
            ) {
                await session.abortTransaction();

                return res.status(400).json({
                    message: 'Name and email are required.',
                    data: null
                });
            }

            var pendingTasks =
                req.body.pendingTasks === undefined
                    ? []
                    : req.body.pendingTasks;

            if (!Array.isArray(pendingTasks)) {
                await session.abortTransaction();

                return res.status(400).json({
                    message: 'pendingTasks must be an array.',
                    data: null
                });
            }

            // Validate every task id
            for (var taskId of pendingTasks) {
                if (
                    typeof taskId !== 'string' ||
                    !mongoose.Types.ObjectId.isValid(taskId)
                ) {
                    await session.abortTransaction();
                    
                    return res.status(400).json({
                        message: 'Invalid task id in pendingTasks.',
                        data: null
                    });
                }
            }

            // Optional duplicate prevention
            if (new Set(pendingTasks).size !== pendingTasks.length) {
                await session.abortTransaction();

                return res.status(400).json({
                    message: 'pendingTasks cannot contain duplicate task ids.',
                    data: null
                });
            }

            // Duplicate email
            var existingUser = await User.findOne({
                email: req.body.email
            }).session(session);

            if (existingUser) {
                await session.abortTransaction();

                return res.status(400).json({
                    message: 'A user with this email already exists.',
                    data: null
                });
            }

            // All referenced tasks must exist
            var tasks = await Task.find({
                _id: { $in: pendingTasks }
            }).session(session);

            if (tasks.length !== pendingTasks.length) {
                await session.abortTransaction();
                
                return res.status(404).json({
                    message: 'One or more tasks were not found.',
                    data: null
                });
            }

            // Completed tasks cannot be pending
            for (var task of tasks) {
                if (task.completed === true) {
                    await session.abortTransaction();
                    
                    return res.status(400).json({
                        message: 'Completed tasks cannot be in pendingTasks.',
                        data: null
                    });
                }
            }

            // Validation finished

            var user = new User({
                name: req.body.name,
                email: req.body.email,
                pendingTasks: pendingTasks
            });

            await user.save({ session: session });

            // Assign every pending task to this new user
            for (var task of tasks) {

                // If task belonged to another user, remove it from that user's pendingTasks
                if (task.assignedUser !== '') {
                    await User.updateOne(
                        { _id: task.assignedUser },
                        {
                            $pull: {
                                pendingTasks: task._id.toString()
                            }
                        },
                        { session: session }
                    );
                }

                task.assignedUser = user._id.toString();
                task.assignedUserName = user.name;

                await task.save({ session: session});
            }
            await session.commitTransaction();

            return res.status(201).json({
                message: 'User created successfully.',
                data: user
            });

        } catch (err) {
            await session.abortTransaction();
            console.error(err);

            return res.status(500).json({
                message: 'Internal server error.',
                data: null
            });
        } finally {
            await session.endSession();
        }
    });


    // ==================================================================
    // GET user by ID
    userRoute.get(async function (req, res) {
        try {
            var userId = req.params.id;

            // malformed ObjectId should return 404
            if (!User.db.base.Types.ObjectId.isValid(userId)) {
                return res.status(404).json({
                    message: 'User not found.',
                    data: null
                });
            }

            var query = User.findById(userId);

            // select is the only query parameter that applies to /:id
            if (req.query.select !== undefined) {
                var select;

                try {
                    select = JSON.parse(req.query.select);
                } catch (err) {
                    return res.status(400).json({
                        message: 'Invalid select parameter.',
                        data: null
                    });
                }

                query = query.select(select);
            }

            var user = await query.exec();

            if (!user) {
                return res.status(404).json({
                    message: 'User not found.',
                    data: null
                });
            }

            return res.status(200).json({
                message: 'OK',
                data: user
            });

        } catch (err) {
            console.error(err);

            return res.status(500).json({
                message: 'Internal server error.',
                data: null
            });
        }
    });


    // ==================================================================
    // PUT user by ID
    userRoute.put(async function (req, res) {
        var session = await mongoose.startSession();

        try {
            session.startTransaction();

            var userId = req.params.id;

            // 1. URL id malformed -> 404
            if (!mongoose.Types.ObjectId.isValid(userId)) {
                await session.abortTransaction();

                return res.status(404).json({
                    message: 'User not found.',
                    data: null
                });
            }

            // 2. User must exist
            var user = await User.findById(userId).session(session);

            if (!user) {
                await session.abortTransaction();

                return res.status(404).json({
                    message: 'User not found.',
                    data: null
                });
            }

            // 3. Validate required fields
            if (
                typeof req.body.name !== 'string' ||
                req.body.name.trim() === '' ||
                typeof req.body.email !== 'string' ||
                req.body.email.trim() === ''
            ) {
                await session.abortTransaction();

                return res.status(400).json({
                    message: 'Name and email are required.',
                    data: null
                });
            }

            // PUT replacement:
            // missing pendingTasks means []
            var newPendingTasks =
                req.body.pendingTasks === undefined
                    ? []
                    : req.body.pendingTasks;

            // pendingTasks must be an array
            if (!Array.isArray(newPendingTasks)) {
                await session.abortTransaction();

                return res.status(400).json({
                    message: 'pendingTasks must be an array.',
                    data: null
                });
            }

            // 4. Every pendingTasks entry must be a valid ObjectId string
            for (var taskId of newPendingTasks) {
                if (
                    typeof taskId !== 'string' ||
                    !mongoose.Types.ObjectId.isValid(taskId)
                ) {
                    await session.abortTransaction();
                    
                    return res.status(400).json({
                        message: 'Invalid task id in pendingTasks.',
                        data: null
                    });
                }
            }

            // Optional: reject duplicate task ids
            if (new Set(newPendingTasks).size !== newPendingTasks.length) {
                await session.abortTransaction();

                return res.status(400).json({
                    message: 'pendingTasks cannot contain duplicate task ids.',
                    data: null
                });
            }

            // 5. Email cannot belong to another user
            var duplicateEmail = await User.findOne({
                email: req.body.email,
                _id: { $ne: userId }
            }).session(session);

            if (duplicateEmail) {
                await session.abortTransaction();

                return res.status(400).json({
                    message: 'A user with this email already exists.',
                    data: null
                });
            }

            // 6. All referenced tasks must actually exist
            var tasks = await Task.find({
                _id: { $in: newPendingTasks }
            }).session(session);

            if (tasks.length !== newPendingTasks.length) {
                await session.abortTransaction();
                
                return res.status(404).json({
                    message: 'One or more tasks were not found.',
                    data: null
                });
            }

            // 7. Completed tasks cannot appear in pendingTasks
            for (var task of tasks) {
                if (task.completed === true) {
                    await session.abortTransaction();
                    
                    return res.status(400).json({
                        message: 'Completed tasks cannot be in pendingTasks.',
                        data: null
                    });
                }
            }

            // two way reference
            var oldPendingTasks = (user.pendingTasks || []).map(function (taskId) {
                return taskId.toString();
            });

            var removedTasks = oldPendingTasks.filter(function (taskId) {
                return !newPendingTasks.includes(taskId);
            });

            var addedTasks = newPendingTasks.filter(function (taskId) {
                return !oldPendingTasks.includes(taskId);
            });

            // 8. Tasks removed from user's pendingTasks become unassigned
            if (removedTasks.length > 0) {
                await Task.updateMany(
                    {
                        _id: { $in: removedTasks },
                        assignedUser: userId
                    },
                    {
                        $set: {
                            assignedUser: '',
                            assignedUserName: 'unassigned'
                        }
                    },
                    { session: session }
                );
            }

            // 9. Tasks newly added become assigned to this user
            for (var addedTaskId of addedTasks) {

                var addedTask = await Task.findById(addedTaskId).session(session);

                // If task belonged to another user, remove it from that user's pendingTasks
                if (
                    addedTask.assignedUser &&
                    addedTask.assignedUser !== userId
                ) {
                    await User.updateOne(
                        { _id: addedTask.assignedUser },
                        {
                            $pull: {
                                pendingTasks: addedTaskId
                            }
                        },
                        { session: session }
                    );
                }

                addedTask.assignedUser = userId;
                addedTask.assignedUserName = req.body.name;

                await addedTask.save({ session: session });
            }

            // 10. If user's name changes, update ALL tasks assigned to this user including completed tasks
            await Task.updateMany(
                {
                    assignedUser: userId
                },
                {
                    $set: {
                        assignedUserName: req.body.name
                    }
                },
                { session: session }
            );

            // 11. Replace user fields
            user.name = req.body.name;
            user.email = req.body.email;
            user.pendingTasks = newPendingTasks;

            // NOT change dateCreated
            await user.save({ session: session });

            await session.commitTransaction();

            return res.status(200).json({
                message: 'User updated successfully.',
                data: user
            });

        } catch (err) {
            await session.abortTransaction();

            console.error(err);

            return res.status(500).json({
                message: 'Internal server error.',
                data: null
            });
        } finally {
            await session.endSession();
        }
    });


    // ==================================================================
    // DELETE /api/users/:id
    userRoute.delete(async function (req, res) {
        var session = await mongoose.startSession();

        try {
            session.startTransaction();

            var userId = req.params.id;

            // malformed URL id -> 404
            if (!mongoose.Types.ObjectId.isValid(userId)) {
                await session.abortTransaction();

                return res.status(404).json({
                    message: 'User not found.',
                    data: null
                });
            }

            var user = await User.findById(userId).session(session);

            if (!user) {
                await session.abortTransaction();

                return res.status(404).json({
                    message: 'User not found.',
                    data: null
                });
            }

            // Unassign ALL tasks that belong to this user, including completed tasks
            await Task.updateMany(
                {
                    assignedUser: userId
                },
                {
                    $set: {
                        assignedUser: '',
                        assignedUserName: 'unassigned'
                    }
                },
                { session: session }
            );

            await User.deleteOne({
                _id: userId
            }, { session: session });

            await session.commitTransaction();

            return res.status(204).send();

        } catch (err) {
            await session.abortTransaction();
            console.error(err);

            return res.status(500).json({
                message: 'Internal server error.',
                data: null
            });
        } finally {
            await session.endSession();
        }
    });

    return router;
};
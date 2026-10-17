// Load required packages
var mongoose = require('mongoose');
var Task = require('../models/task');
var User = require('../models/user');

module.exports = function (router) {

    var tasksRoute = router.route('/tasks');
    var taskRoute = router.route('/tasks/:id');


    // ==================================================================
    // GET
    tasksRoute.get(async function (req, res) {
        try {
            var where = {};
            var sort = {};
            var select = null;

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

            // Tasks default limit = 100
            var limit = 100;

            if (req.query.limit !== undefined) {
                limit = Number(req.query.limit);

                if (!Number.isInteger(limit) || limit < 0) {
                    return res.status(400).json({
                        message: 'limit must be a non-negative integer.',
                        data: null
                    });
                }
            }

            if (req.query.count === 'true') {
                var countQuery = Task.countDocuments(where);

                if (skip > 0) {
                    countQuery = countQuery.skip(skip);
                }

                countQuery = countQuery.limit(limit);

                var count = await countQuery.exec();

                return res.status(200).json({
                    message: 'OK',
                    data: count
                });
            }

            var query = Task.find(where);

            query = query.sort(sort);

            if (select !== null) {
                query = query.select(select);
            }

            if (skip > 0) {
                query = query.skip(skip);
            }

            query = query.limit(limit);

            var tasks = await query.exec();

            return res.status(200).json({
                message: 'OK',
                data: tasks
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
    tasksRoute.post(async function (req, res) {
        var session = await mongoose.startSession();

        try {
            session.startTransaction();

            // Required fields
            if (
                typeof req.body.name !== 'string' ||
                req.body.name.trim() === ''
            ) {
                await session.abortTransaction();

                return res.status(400).json({
                    message: 'Task name is required.',
                    data: null
                });
            }

            if (
                req.body.deadline === undefined ||
                isNaN(new Date(req.body.deadline).getTime())
            ) {
                await session.abortTransaction();
                
                return res.status(400).json({
                    message: 'A valid deadline is required.',
                    data: null
                });
            }

            var description =
                req.body.description === undefined
                    ? ''
                    : req.body.description;

            var completed =
                req.body.completed === undefined
                    ? false
                    : req.body.completed;

            var assignedUser =
                req.body.assignedUser === undefined
                    ? ''
                    : req.body.assignedUser;

            if (typeof description !== 'string') {
                await session.abortTransaction();

                return res.status(400).json({
                    message: 'description must be a string.',
                    data: null
                });
            }

            if (typeof completed !== 'boolean') {
                await session.abortTransaction();

                return res.status(400).json({
                    message: 'completed must be a boolean.',
                    data: null
                });
            }

            if (typeof assignedUser !== 'string') {
                await session.abortTransaction();

                return res.status(400).json({
                    message: 'assignedUser must be a string.',
                    data: null
                });
            }

            if (
                req.body.assignedUserName !== undefined &&
                typeof req.body.assignedUserName !== 'string'
            ) {
                await session.abortTransaction();

                return res.status(400).json({
                    message: 'assignedUserName must be a string.',
                    data: null
                });
            }

            var assignedUserDocument = null;
            var assignedUserName = 'unassigned';

            if (assignedUser !== '') {

                // malformed body id -> 400
                if (!mongoose.Types.ObjectId.isValid(assignedUser)) {
                    await session.abortTransaction();

                    return res.status(400).json({
                        message: 'Invalid assignedUser id.',
                        data: null
                    });
                }

                assignedUserDocument =
                    await User.findById(assignedUser).session(session);

                // valid format but no user -> 404
                if (!assignedUserDocument) {
                    await session.abortTransaction();

                    return res.status(404).json({
                        message: 'Assigned user not found.',
                        data: null
                    });
                }

                assignedUserName = assignedUserDocument.name;

                // supplied name must match actual user name
                if (
                    req.body.assignedUserName !== undefined &&
                    req.body.assignedUserName !== assignedUserDocument.name
                ) {
                    await session.abortTransaction();

                    return res.status(400).json({
                        message:
                            'assignedUserName does not match assignedUser.',
                        data: null
                    });
                }

            } else {
                if (
                    req.body.assignedUserName !== undefined &&
                    req.body.assignedUserName !== 'unassigned'
                ) {
                    await session.abortTransaction();

                    return res.status(400).json({
                        message:
                            'Unassigned tasks must use assignedUserName "unassigned".',
                        data: null
                    });
                }
            }

            // Validation finished

            var task = new Task({
                name: req.body.name,
                description: description,
                deadline: req.body.deadline,
                completed: completed,
                assignedUser: assignedUser,
                assignedUserName: assignedUserName
            });

            await task.save({ session: session });

            // assigned + incomplete -> add to pendingTasks
            if (
                assignedUser !== '' &&
                completed === false
            ) {
                await User.updateOne(
                    { _id: assignedUser },
                    {
                        $addToSet: {
                            pendingTasks: task._id.toString()
                        }
                    },
                    { session: session }
                );
            }

            await session.commitTransaction();

            return res.status(201).json({
                message: 'Task created successfully.',
                data: task
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
    // GET task by ID
    taskRoute.get(async function (req, res) {
        try {
            var taskId = req.params.id;

            if (!Task.db.base.Types.ObjectId.isValid(taskId)) {
                return res.status(404).json({
                    message: 'Task not found.',
                    data: null
                });
            }

            var query = Task.findById(taskId);

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

            var task = await query.exec();

            if (!task) {
                return res.status(404).json({
                    message: 'Task not found.',
                    data: null
                });
            }

            return res.status(200).json({
                message: 'OK',
                data: task
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
    // PUT /api/tasks/:id
    taskRoute.put(async function (req, res) {
        var session = await mongoose.startSession();

        try {
            session.startTransaction();

            var taskId = req.params.id;

            // 1. URL id malformed -> 404
            if (!mongoose.Types.ObjectId.isValid(taskId)) {
                await session.abortTransaction();

                return res.status(404).json({
                    message: 'Task not found.',
                    data: null
                });
            }

            // 2. Task must exist
            var task = await Task.findById(taskId).session(session);

            if (!task) {
                await session.abortTransaction();
                
                return res.status(404).json({
                    message: 'Task not found.',
                    data: null
                });
            }

            // 3. Validate required fields
            if (
                typeof req.body.name !== 'string' ||
                req.body.name.trim() === ''
            ) {
                await session.abortTransaction();

                return res.status(400).json({
                    message: 'Task name is required.',
                    data: null
                });
            }

            if (
                req.body.deadline === undefined ||
                isNaN(new Date(req.body.deadline).getTime())
            ) {
                await session.abortTransaction();
                
                return res.status(400).json({
                    message: 'A valid deadline is required.',
                    data: null
                });
            }

            // 4. PUT replacement defaults
            var newDescription =
                req.body.description === undefined
                    ? ''
                    : req.body.description;

            var newCompleted =
                req.body.completed === undefined
                    ? false
                    : req.body.completed;

            var newAssignedUser =
                req.body.assignedUser === undefined
                    ? ''
                    : req.body.assignedUser;

            // Type checks
            if (typeof newDescription !== 'string') {
                await session.abortTransaction();
                
                return res.status(400).json({
                    message: 'description must be a string.',
                    data: null
                });
            }

            if (typeof newCompleted !== 'boolean') {
                await session.abortTransaction();
                
                return res.status(400).json({
                    message: 'completed must be a boolean.',
                    data: null
                });
            }

            if (typeof newAssignedUser !== 'string') {
                await session.abortTransaction();
                
                return res.status(400).json({
                    message: 'assignedUser must be a string.',
                    data: null
                });
            }

            // assignedUserName, if supplied, must also be a string
            if (
                req.body.assignedUserName !== undefined &&
                typeof req.body.assignedUserName !== 'string'
            ) {
                await session.abortTransaction();

                return res.status(400).json({
                    message: 'assignedUserName must be a string.',
                    data: null
                });
            }

            var assignedUserDocument = null;
            var newAssignedUserName = 'unassigned';

            // 5. Validate assignment
            if (newAssignedUser !== '') {

                // malformed assignedUser in BODY -> 400
                if (!mongoose.Types.ObjectId.isValid(newAssignedUser)) {
                    await session.abortTransaction();

                    return res.status(400).json({
                        message: 'Invalid assignedUser id.',
                        data: null
                    });
                }

                // valid id, but user doesn't exist -> 404
                assignedUserDocument =
                    await User.findById(newAssignedUser).session(session);

                if (!assignedUserDocument) {
                    await session.abortTransaction();

                    return res.status(404).json({
                        message: 'Assigned user not found.',
                        data: null
                    });
                }

                newAssignedUserName = assignedUserDocument.name;

                // If client supplied assignedUserName, it must match the actual user's name
                if (
                    req.body.assignedUserName !== undefined &&
                    req.body.assignedUserName !== assignedUserDocument.name
                ) {
                    await session.abortTransaction();

                    return res.status(400).json({
                        message:
                            'assignedUserName does not match assignedUser.',
                        data: null
                    });
                }

            } else {
                // If unassigned, assignedUserName must be omitted or "unassigned"
                if (
                    req.body.assignedUserName !== undefined &&
                    req.body.assignedUserName !== 'unassigned'
                ) {
                    await session.abortTransaction();

                    return res.status(400).json({
                        message:
                            'Unassigned tasks must use assignedUserName "unassigned".',
                        data: null
                    });
                }
            }

            // ---- Validation finished ----

            var oldAssignedUser = task.assignedUser;

            // 6. If task used to belong to someone and assignment changed, remove from old user's pendingTasks
            if (
                oldAssignedUser &&
                oldAssignedUser !== newAssignedUser
            ) {
                await User.updateOne(
                    { _id: oldAssignedUser },
                    {
                        $pull: {
                            pendingTasks: taskId
                        }
                    },
                    { session: session }
                );
            }

            // 7. Update new/current user's pendingTasks
            if (newAssignedUser !== '') {

                if (newCompleted === true) {
                    // Completed task stays assigned, but is NOT pending
                    await User.updateOne(
                        { _id: newAssignedUser },
                        {
                            $pull: {
                                pendingTasks: taskId
                            }
                        },
                        { session: session }
                    );
                } else {
                    // Assigned + incomplete -> pending
                    await User.updateOne(
                        { _id: newAssignedUser },
                        {
                            $addToSet: {
                                pendingTasks: taskId
                            }
                        },
                        { session: session }
                    );
                }
            }

            // 8. Replace task fields
            task.name = req.body.name;
            task.description = newDescription;
            task.deadline = req.body.deadline;
            task.completed = newCompleted;
            task.assignedUser = newAssignedUser;
            task.assignedUserName = newAssignedUserName;
            // dateCreated NOT changed

            await task.save({ session: session });
            await session.commitTransaction();

            return res.status(200).json({
                message: 'Task updated successfully.',
                data: task
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
    // DELETE /api/tasks/:id
    taskRoute.delete(async function (req, res) {
        var session = await mongoose.startSession();

        try {
            session.startTransaction();

            var taskId = req.params.id;

            // malformed URL id -> 404
            if (!mongoose.Types.ObjectId.isValid(taskId)) {
                await session.abortTransaction();

                return res.status(404).json({
                    message: 'Task not found.',
                    data: null
                });
            }

            var task = await Task.findById(taskId).session(session);

            if (!task) {
                await session.abortTransaction();

                return res.status(404).json({
                    message: 'Task not found.',
                    data: null
                });
            }

            // If assigned to a user, remove from that user's pendingTasks
            if (task.assignedUser !== '') {
                await User.updateOne(
                    { _id: task.assignedUser },
                    {
                        $pull: {
                            pendingTasks: taskId
                        }
                    },
                    { session: session }
                );
            }

            await Task.deleteOne(
                {_id: taskId},
                { session: session }
            );

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
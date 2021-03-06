"use strict";
var util = require('util');
var process = require('process');
var request = require('request-promise-native');
var builder = require("botbuilder");
var vso = require('./vso');
var settings = require('./settings');

module.exports = {
    setupDialogs: setupDialogs,
    oauthHandler: oauthHandler
}

function oauthHandler(bot) {
    return (req, res) => {
        res.contentType = "text/plain";
        var uid = req.query.state;
        var code = req.query.code;

        if (!bot.oauthPending[uid]) {
            res.send("Wrong callback");
            return;
        } else {
            res.send('Thank you, I will now check if you have access. You can close this tab');
        }

        var form = {
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: process.env.OauthAppSecret,
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: code,
            redirect_uri: process.env.OauthCallbackURL
        };
        var opts = {
            url: 'https://app.vssps.visualstudio.com/oauth2/token', 
            method: 'POST',
            form: form,
            timeout: 1000,
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            json: true
        }
        request(opts)
            .then((res) => {
                var accessToken = res.access_token;
                vso.getProfile(accessToken, 'me')
                    .then((profile) => { bot.oauthPending[uid].resolve(profile) })
                    .catch((err) => { bot.oauthPending[uid].reject("Cannot get VSO profile")});
            }).catch((err) => {
                bot.oauthPending[uid].reject("Cannot get OAuth token: " + err);
            });
    }
}

function setupDialogs(bot) {
    bot.dialog('ExecuteCommands', (session, args, next) => {
        var commands = args.intent.entities.commands;
        for (var i = 0; i < commands.length; i++) { 
            var command = commands[i];
            if (command.type === 'Authenticate') {
                authenticateUser(bot, session);
                break;
            }
            if (!session.userData.vsoProfile) {
                session.send("Sorry, I don't know you. Use command 'authenticate' first");
                break;
            }
            var opts = command.opts;
            switch (command.type) {
                case 'Say':
                    session.send(opts.text);
                    break;
                case 'UserSet':
                    var prev = session.userData[opts.variable];
                    session.userData[opts.variable] = opts.value;
                    session.send(util.format("New value for '%s' saved. Previous was %s", opts.variable, prev));
                    break
                case 'Set':
                    var prev = session.conversationData[opts.variable];
                    session.conversationData[opts.variable] = opts.value;
                    session.save()
                    session.send(util.format("New value for '%s' saved. Previous was %s", opts.variable, prev));
                    break
                case 'Get':
                    var v = session.conversationData[opts.variable];
                    session.send(opts.variable + ' = ' + v);
                    break;
                case 'Dump':
                    session.send("userData: " + JSON.stringify(session.userData));
                    session.send("conversationData: " + JSON.stringify(session.conversationData));
                    break;
                case 'CommentTask':
                    vso.commentTask(session, opts.item, opts.comment)
                        .then((wit) => { session.send("Comment was added to item #" + wit.id); })
                        .catch((err) => { session.send("Cannot comment item: " + err); });
                    break;
                case 'CreateBauTask':
                    vso.createTask(session, true, opts.title, opts.description)
                        .then((wit) => { session.send("Sure, created task #" + wit.id); })
                        .catch((err) => { session.send("Cannot create task: " + err); });
                    break;
                case 'CreateTask':
                    vso.createTask(session, false, opts.title, opts.description)
                        .then((wit) => { session.send("Sure, created task #" + wit.id); })
                        .catch((err) => { session.send("Cannot create task: " + err); });
                    break;
                case 'AssignTask':
                    vso.AssignTask(session, opts.item, opts.person, opts.comment)
                        .then((wit) => { session.send("Assigned to" + wit.fields['System.AssignedTo']); })
                        .catch((err) => { session.send("Cannot assign task: " + err); });
                    break;
                case 'UnassignTask':
                    vso.AssignTask(session, opts.item, null, opts.comment)
                        .then((wit) => { session.send("Ok, unassigned"); })
                        .catch((err) => { session.send("Cannot unassign task: " + err); });
                    break;
                default:
                    session.send("Unknown command");
            }
        }
    }).triggerAction({matches: 'ExecuteCommands'});
}

function authenticateUser(bot, session) {
    var userId = session.message.address.user.id;
    var appId = process.env.OauthAppId;
    var scope = 'vso.profile';
    var cbUrl = process.env.OauthCallbackURL;
    var userAddr = Object.assign({}, session.message.address); delete userAddr.conversation;  //copy session address, remove conversation from there => user address
    var url = util.format("https://app.vssps.visualstudio.com/oauth2/authorize?client_id=%s&response_type=Assertion&state=%s&scope=%s&redirect_uri=%s", appId, userId, scope, cbUrl);
    var msg = new builder.Message();
    msg.attachments([
            new builder.SigninCard(session).button('Go to VSO', url).text('Please authenticate yourself against VSO')
    ]);
    msg.address(userAddr);
    if (session.message.address.conversation.isGroup) {
        session.send("Ok, let's take 1:1");
    }
    bot.send(msg);
    new Promise( (resolve, reject) => {
        if (!bot.oauthPending) {
            bot.oauthPending = {}
        }
        bot.oauthPending[userId] = {resolve: resolve, reject: reject}     // to be called by oauth handler
        setTimeout( () => {reject("Timeout")}, 60000);
    }).then((profile) => {
        var msg = new builder.Message().address(userAddr);
        if (profile.emailAddress.match(/@(microsoft|skype)\.com$/i)) {
            msg.text(util.format("Authenticated as %s %s", profile.emailAddress, profile.displayName));
            session.userData.vsoProfile = profile;
        } else {
            msg.text(util.format("Sorry, appears that your VSO profile %s %s should not have access", profile.emailAddress, profile.displayName));
            delete(session.userData.vsoProfile);
        }
        session.save();
        bot.send(msg);
    }).catch((err) => {
        console.log("Got error while processing OAuth callback: " + err);
        var msg = new builder.Message().address(userAddr);
        msg.text("Authentication failed: " + striptags(err));
        bot.send(msg);
    });

}

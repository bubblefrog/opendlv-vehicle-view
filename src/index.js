// Copyright (C) 2018  Christian Berger
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

// Dependencies.
var dgram = require('dgram');
const fs = require('fs');
var express = require("express");
var exphbs  = require('express-handlebars');
const { exec, execSync } = require('child_process');

////////////////////////////////////////////////////////////////////////////////
var PORT = process.env.PORT || 8081;
var LIVE_OD4SESSION_CID = process.env.OD4SESSION_CID || 111;
var PLAYBACK_OD4SESSION_CID = process.env.PLAYBACK_OD4SESSION_CID || 253;

////////////////////////////////////////////////////////////////////////////////
// Killing process groups (used to stop cluon-OD4toStdout.
var psTree = require('ps-tree');

var kill = function (pid) {
    signal = 'SIGKILL';
    if (process.platform !== 'win32') {
        psTree(pid, function (err, children) {
            [pid].concat(
                children.map(function (p) {
                    return p.PID;
                })
            ).forEach(function (tpid) {
                try { process.kill(tpid, signal) }
                catch (e) {}
            });
        });
    }
};

////////////////////////////////////////////////////////////////////////////////
// Web server.
var app = express();
var path = require('path');

// Template engine.
app.engine('.hbs', exphbs({extname: '.hbs'}));
app.set('view engine', '.hbs');

// Default landing page.
app.get("/", function(req, res) {
    res.render('main', { livePage: true });
});

app.get("/playback", function(req, res) {
    res.render('main', { playbackPage: true });
});

//------------------------------------------------------------------------------
// Handle existing recording files.
const addThousandsSeparator = (x) => {
    return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
app.get("/recordings", function(req, res) {
    const testFolder = './recordings';
    var files = { recfiles: [] };
    fs.readdirSync(testFolder).forEach(file => {
        var size = fs.statSync(path.join(testFolder + '/' + file)).size;
        size = addThousandsSeparator(size);
        files.recfiles.push({
            "name"      : file,
            "filename"  : testFolder + "/" + file,
            "size"      : size
        });
    });
    res.render('recordings', files);
});

//------------------------------------------------------------------------------
// Handle POST requests.
var bodyParser = require('body-parser');
app.use(bodyParser.json()); // support json encoded bodies
app.use(bodyParser.urlencoded({ extended: true })); // support encoded bodies

app.post('/convertrecfile', (req, res) => {
console.log(req.body);
    var process_cluonrec2csv = execSync('cluon-rec2csv --rec=' + req.body.recordingFileToConvert + ' --odvd=opendlv-standard-message-set-v0.9.5.odvd && zip ./' + req.body.recordingFile + '.csv.zip *.csv && rm -f *.csv');
    console.log('[opendlv-vehicle-view] Started cluon-rec2csv, PID: ' + process_cluonrec2csv.pid);

    res.send ({
        status      : "200",
        responseType: "string",
        response    : "success"
    });
});

var g_replayRunning = false;
var g_cluonreplay;
app.post('/replayrecfile', (req, res) => {
    g_replayRunning = true;
    g_cluonreplay = exec('cluon-replay --keeprunning --cid=' + PLAYBACK_OD4SESSION_CID + ' ' + req.body.recordingFileToPlay);
    console.log('[opendlv-vehicle-view] Started cluon-replay, PID: ' + g_cluonreplay.pid);

    res.send ({
        status      : "200",
        responseType: "string",
        response    : "success"
    });
});
app.post('/endreplay', (req, res) => {
    try { kill(g_cluonreplay.pid); } catch (e) { console.log(e); }
    console.log('[opendlv-vehicle-view] Stopped cluon-replay, PID: ' + g_cluonreplay.pid);

    res.send ({
        status      : "200",
        responseType: "string",
        response    : "success"
    });
    g_replayRunning = false;
});
app.post('/deleterecfile', (req, res) => {
    fs.unlink(req.body.recordingFileToDelete, function() {
        res.send ({
            status      : "200",
            responseType: "string",
            response    : "success"
        });
    });
});

//------------------------------------------------------------------------------
// Serve other static files.
app.get(/^(.+)$/, function(req, res){
    res.sendFile(path.join(__dirname + '/' + req.params[0]));
});

//------------------------------------------------------------------------------
// Start server.
var server = app.listen(PORT, function () {
    console.log('[opendlv-vehicle-view] Web server listening on port: ' + PORT + ', joining live OD4Session ' + LIVE_OD4SESSION_CID + ', using OD4Session ' + PLAYBACK_OD4SESSION_CID + ' for playback.');
})

////////////////////////////////////////////////////////////////////////////////
// Websocket stuff.
var g_cluonOD4toStdout;
const WebSocket = require('ws').Server;
const g_ws = new WebSocket({server});
g_ws.on('connection', function connection(conn) {
    conn.on('message', function(msg) {
        if ( /* Ensure we have pure JSON. */ (msg[0] == '{') && (msg[msg.length-1] == '}') ) {
            var data = JSON.parse(msg);
            Object.keys(data).forEach(function(key) {
                if ('record' == key) {
                    if (data.record) {
                        g_cluonOD4toStdout = exec('cluon-OD4toStdout --cid=' + LIVE_OD4SESSION_CID + ' > ./recordings/`date +CID-' + LIVE_OD4SESSION_CID + '-recording-%Y-%m-%d_%H%M%S.rec`');
                        console.log('[opendlv-vehicle-view] Started cluon-OD4toStdout, PID: ' + g_cluonOD4toStdout.pid);
                    }
                    else {
                        try { kill(g_cluonOD4toStdout.pid); } catch (e) { console.log(e); }
                        console.log('[opendlv-vehicle-view] Stopped cluon-OD4toStdout, PID: ' + g_cluonOD4toStdout.pid);
                    }
                }
                if ('remoteplayback' == key) {
                    // Unpack Proto-encoded Envelope and forward command to playback OD4Session.
                    g_playbackOD4Session.send(Buffer.from(data.remoteplayback, 'base64'), 12175, '225.0.0.' + PLAYBACK_OD4SESSION_CID);
                }
            });
        }
    });
});

////////////////////////////////////////////////////////////////////////////////
// Broadcast to connected websocket clients.
var broadcastMessage = function (msg, fromLive) {
    if ( ( (fromLive && !g_replayRunning) /* Forward either from live OD4Session */ ) ||
         ( (!fromLive && g_replayRunning) /* or from replay OD4Session but not from both. */ ) ) {
        g_ws.clients.forEach(function each(client) {
            if (client.readyState == 1 /*WebSocket.OPEN*/) {
                client.send(msg);
            }
        });
    }
};

////////////////////////////////////////////////////////////////////////////////
// Connect to live OD4Session to broadcast messages to connected websocket clients.
var g_liveOD4Session = dgram.createSocket({reuseAddr:true, type:'udp4'});
g_liveOD4Session.bind({ 'port' : 12175 /* OD4Session UDP multicast port */, 'address': '225.0.0.' + LIVE_OD4SESSION_CID, 'exclusive' : false });
g_liveOD4Session.on('listening', function() {
    g_liveOD4Session.addMembership('225.0.0.' + LIVE_OD4SESSION_CID);
});
g_liveOD4Session.on('message', function(msg, rinfo) {
    broadcastMessage(msg, true);
});

////////////////////////////////////////////////////////////////////////////////
// Connect to playback OD4Session to broadcast messages to connected websocket clients.
var g_playbackOD4Session = dgram.createSocket({reuseAddr:true, type:'udp4'});
g_playbackOD4Session.bind({ 'port' : 12175 /* OD4Session UDP multicast port */, 'address': '225.0.0.' + PLAYBACK_OD4SESSION_CID, 'exclusive' : false });
g_playbackOD4Session.on('listening', function() {
    g_playbackOD4Session.addMembership('225.0.0.' + PLAYBACK_OD4SESSION_CID);
});
g_playbackOD4Session.on('message', function(msg, rinfo) {
    broadcastMessage(msg, false);
});


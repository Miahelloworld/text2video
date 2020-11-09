/*
 * Copyright 2015, Gregg Tavares.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 *     * Redistributions of source code must retain the above copyright
 * notice, this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above
 * copyright notice, this list of conditions and the following disclaimer
 * in the documentation and/or other materials provided with the
 * distribution.
 *     * Neither the name of Gregg Tavares. nor the names of its
 * contributors may be used to endorse or promote products derived from
 * this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

'use strict';

var debug = require('debug')('video-server');
var events = require('events');
var express = require('express');
var fs = require('fs');
var http = require('http');
var path = require('path');
var url = require('url');
var AWS = require('aws-sdk');
var Stream = require('stream');
var bodyParser = require('body-parser');
var config = require('./config');

var statP = fs.promises.stat;

/**
 * @param {VideoServer~Options} options
 * @param {function(err): void} startedCallback called with err
 *        of error, undefined if successful.
 */
var VideoServer = function (options, startedCallback) {
  options = options || {};
  var self = this;
  var g = {
    port: config.PORT,
    baseDir: 'public',
    cwd: process.cwd(),
    files: {},
  };

  Object.keys(options).forEach(function (prop) {
    g[prop] = options[prop];
  });

  var app = express();
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: true }));

  var polly = new AWS.Polly({
    signatureVersion: "v4",
    region: config.AWS_REGION,
    accessKeyId: config.AWS_ACCESS_KEY_ID,
    secretAccessKey: config.AWS_SECRET_ACCESS_KEY
  });

  app.post("/api/v1/speech", (req, res) => {
    var params = {
      Text: req.body.text,
      VoiceId: req.body.voiceId,
      OutputFormat: "mp3"
    }
    polly.synthesizeSpeech(params, (err, data) => {
      if (err) {
        res.json({ error: JSON.stringify(err.code) });
      }
      else if (data) {
        if (data.AudioStream instanceof Buffer) {
          var speechName = path.join(g.videoDir, "speech.mp3");
          var writeStream = fs.createWriteStream(speechName);
          var bufferStream = new Stream.PassThrough();
          bufferStream.end(data.AudioStream);
          bufferStream.pipe(writeStream);
          writeStream.on("finish", function () {
            var audioData = {};
            fs.readFile(speechName, function (err, file) {
              if (err) {
                res.json({ error: JSON.stringify(err) });
              }
              else {
                var base64File = Buffer.from(file, "binary").toString("base64");
                audioData.fileContent = base64File;
                params.OutputFormat = "json";
                params.SpeechMarkTypes = ["word", "sentence"];
                polly.synthesizeSpeech(params, (err, data) => {
                  if (err) {
                    res.json({ error: JSON.stringify(err.code) });
                  }
                  else if (data) {
                    if (data.AudioStream instanceof Buffer) {
                      var buf = Buffer.from(data.AudioStream);
                      var lines = buf.toString().split("\n");
                      var markData = [];
                      for (var line of lines) {
                        if (line) {
                          markData.push(JSON.parse(line));
                        }
                      }
                      res.json({
                        audioData: audioData,
                        markData: markData
                      });
                    }
                  }
                });
              }
              fs.unlink(speechName, (err) => { // delete the file
                if (err) {
                  console.log(err);
                }
              });
            });
          });
        }
      }
    });
  });

  var handleOPTIONS = function (req, res) {
    res.removeHeader('Content-Type');
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept',
      'Access-Control-Allow-Credentials': false,
      'Access-Control-Max-Age': 86400,
    });
    res.end('{}');
  };

  var handleDownload = function (req, res) {
    var fileId = req.params[0];
    var fileInfo = g.files[fileId];
    if (!fileInfo) {
      debug("no such fileId: " + fileId);
      return res.status(404).send('no file: ' + fileId);
    }
    debug("download: " + fileInfo.path);
    setTimeout(function () {
      res.sendFile(fileInfo.path);
    }, 1);
  };

  //  app.use(/^\/api\/v0\/uploadFile\//, busboy());
  //  app.post(/^\/api\/v0\/uploadFile\//, addUploadedFile);
  //  app.post(/.*/, bodyParser);
  //  app.get(/^\/frameencoder\/frameencoder\.js$/, function(req, res) {
  //    debug("send frameencoder");
  //    res.end("frameencoder");
  //  });
  app.get(/^\/frameencoder\/downloads\/(.*?)$/, handleDownload);
  app.options(/.*/, handleOPTIONS);
  app.use('/ffmpegserver', express.static(path.join(__dirname, '..', 'dist')));
  app.use(express.static(g.baseDir));

  function serverErrorHandler() {
    ++g.port;
    tryToStartServer();
  };

  var server = options.httpServerFactory ? options.httpServerFactory(app) : http.createServer(app);
  var socketServer;

  function serverListeningHandler() {
    var SocketServer = require('./socket-server');
    socketServer = options.socketServer || new SocketServer(server, {
      videoDir: options.videoDir,
      frameDir: options.frameDir,
      keepFrames: options.keepFrames,
      allowArbitraryFfmpegArguments: options.allowArbitraryFfmpegArguments,
      polly: polly
    });
    socketServer.setVideoServer(self);
    console.log("Listening on port:", g.port);
    if (startedCallback) {
      startedCallback();
    }
  };

  function tryToStartServer() {
    server.listen(process.env.PORT || g.port);
  }

  server.once('error', serverErrorHandler);
  server.once('listening', serverListeningHandler);
  tryToStartServer();

  /**
   * Close the HFTServer
   * @todo make it no-op after it's closed?
   */
  this.close = function () {
    socketServer.close();
    server.close();
  };

  this.on = function () {
    eventEmitter.on.apply(eventEmitter, arguments);
  };

  this.addListener = function () {
    eventEmitter.addListener.apply(eventEmitter, arguments);
  };

  this.removeListener = function () {
    eventEmitter.removeListener.apply(eventEmitter, arguments);
  };

  //  this.handleRequest = function(req, res) {
  //    app(req, res);
  //  };
  this.getServer = function () {
    return server;
  };

  this.getApp = function () {
    return app;
  };

  this.addFile = function (filename) {
    var basename = path.basename(filename);
    var pathname = "/frameencoder/downloads/" + basename;
    g.files[basename] = {
      path: filename,
    };
    return statP(filename)
      .then(function (stat) {
        return {
          pathname: pathname,
          size: stat.size,
        };
      })
      .catch(function (e) {
        console.error(e);
        throw e;
      });
  };
};

module.exports = VideoServer;

var fs       = require('fs'),
    path     = require('path'),
    async    = require('../support/async.min.js'),
    os       = require('os').platform(),
    exec     = require('child_process').exec,
    spawn    = require('child_process').spawn,
    Registry = require('./registry'),

exports = module.exports = function Processor(command) {
  // constant for timeout checks
  this.E_PROCESSTIMEOUT = -99;
  this._codecDataAlreadySent = false;

  this.saveToFile = function(targetfile, callback) {

    callback = callback || function() {};

    this.options.outputfile = targetfile;

    var self = this;
    var options = this.options;

    // parse options to command
    this._prepare(function(err, meta) {

      if (err) {
        return callback(null, null, err);
      }

      var args = self.buildFfmpegArgs(false, meta);

      if (!args instanceof Array) {
        return callback (null, null, args);
      }

      // start conversion of file using spawn
      var ffmpegProc = self._spawnProcess(args);
      if (options.inputstream) {
        // pump input stream to stdin
        options.inputstream.resume();
        options.inputstream.pipe(ffmpegProc.stdin);
      }

      //handle timeout if set
      var processTimer;
      if (options.timeout) {
        processTimer = setTimeout(function() {
          ffmpegProc.removeAllListeners('exit');
          ffmpegProc.kill('SIGKILL');
          options.logger.warn('process ran into a timeout (' + self.options.timeout + 's)');
          callback(self.E_PROCESSTIMEOUT, 'timeout');
        }, options.timeout * 1000);
      }

      var stdout = '';
      var stderr = '';
      ffmpegProc.on('exit', function(code) {
        if (processTimer) {
          clearTimeout(processTimer);
        }
        // check if we have to run flvtool2 to update flash video meta data
        if (self.options._updateFlvMetadata === true) {
          // make sure we didn't try to determine this capability before
          if (!Registry.instance.get('capabilityFlvTool2')) {
            // check if flvtool2 is installed
            exec('which flvtool2', function(whichErr, whichStdOut, whichStdErr) {
              if (whichStdOut !== '') {
                Registry.instance.set('capabilityFlvTool2', true);
                // update metadata in flash video
                exec('flvtool2 -U ' + self.options.outputfile, function(flvtoolErr, flvtoolStdout, flvtoolStderr) {
                  callback(stdout, stderr, null);
                });
              } else {
                // flvtool2 is not installed, skip further checks
                Registry.instance.set('capabilityFlvTool2', false);
                callback(stdout, stderr, null);
              }
            });
          } else if (!Registry.instance.get('capabilityFlvTool2')) {
            // flvtool2 capability was checked before, execute update
            exec('flvtool2 -U ' + self.options.outputfile, function(flvtoolErr, flvtoolStdout, flvtoolStderr) {
              callback(stdout, stderr, null);
            });
          } else {
            // flvtool2 not installed, skip update
            callback(stdout, stderr, null);
          }
        } else {
          callback(stdout, stderr, null);
        }
      });
      ffmpegProc.stdout.on('data', function (data) {
        stdout += data;
      });

      ffmpegProc.stderr.on('data', function (data) {
        stderr += data;
        if (options.onCodecData) {
          self._checkStdErrForCodec(stderr);
        }
        if (options.onProgress) {
          self._getProgressFromStdErr(stderr, meta.durationsec);
        }
      });
    });
  };

  this.writeToStream = function(stream, callback) {

    callback = callback || function(){};

    if (!this.options._isStreamable) {
      this.options.logger.error('selected output format is not streamable');
      return callback(null, new Error('selected output format is not streamable'));
    }

    var self    = this;
    var options = this.options;

    // parse options to command
    this._prepare(function(err, meta) {
      if (err) {
        return callback(null, err);
      }

      var args = self.buildFfmpegArgs(true, meta);

      if (!args instanceof Array) {
        return callback(null, args);
      }
      // write data to stdout
      args.push('pipe:1');

      // start conversion of file using spawn
      var ffmpegProc = self._spawnProcess(args);

      if (options.inputstream) {
        // pump input stream to stdin
        options.inputstream.resume();
        options.inputstream.pipe(ffmpegProc.stdin);
      }

      //handle timeout if set
      var processTimer;
      if (options.timeout) {
        processTimer = setTimeout(function() {
          ffmpegProc.removeAllListeners('exit');
          ffmpegProc.kill('SIGKILL');
          options.logger.warn('process ran into a timeout (' + options.timeout + 's)');
          callback(self.E_PROCESSTIMEOUT, 'timeout');
        }, options.timeout * 1000);
      }

      var stderr = '';

      ffmpegProc.stderr.on('data', function(data) {
        stderr += data;
        if (options.onCodecData) {
          self._checkStdErrForCodec(stderr);
        }
        if (options.onProgress) {
          self._getProgressFromStdErr(stderr, meta.durationsec);
        }
      });

      ffmpegProc.stdout.on('data', function(chunk) {
        stream.write(chunk);
      });

      ffmpegProc.on('exit', function(code, signal) {
        if (processTimer) {
          clearTimeout(processTimer);
        }
        // close file descriptor on outstream
        if(/^[a-z]+:\/\//.test(options.inputfile)) {
          return callback(code, stderr);
        }

        var cb_ = function() {
          if (!options.inputstream) {
            return callback(code, stderr);
          }
          fs.close(options.inputstream.fd, function() {
            callback(code, stderr);
          });
        };

        if (stream.fd) {
          return fs.close(stream.fd, cb_);
        }
        if (stream.end) {
          stream.end();
        } else {
          callback(code, "stream will not be closed");
        }
        cb_();
      });
    });
  };

  this.takeScreenshots = function(config, folder, callback) {

    callback = callback || function(){};

    function _zeroPad(number, len) {
      return new Array(len-String(number).length+2).join('0')+number;
    }
    
    function _renderOutputName(j, offset) {
      var result = filename;
      if(/%0*i/.test(result)) {
        var numlen = String(result.match(/%(0*)i/)[1]).length;
        result = result.replace(/%0*i/, _zeroPad(j, numlen));
      }
      result = result.replace('%s', offset);
      result = result.replace('%w', self.options.video.width);
      result = result.replace('%h', self.options.video.height);
      result = result.replace('%r', self.options.video.width+'x'+self.options.video.height);
      result = result.replace('%f', self.options.inputfile);
      result = result.replace('%b', self.options.inputfile.substr(0,self.options.inputfile.lastIndexOf('.')));
      return result;
    }
    
    function _screenShotInternal(callback) {

      // get correct dimensions
      self._prepare(function(err, meta) {

        if (!meta.durationsec) {
          var errString = 'meta data contains no duration, aborting screenshot creation';
          self.options.logger.warn(errString);
          return callback(new Error(errString));
        }

        // check if all timemarks are inside duration
        if (timemarks !== null) {
          for (var i = 0; i < timemarks.length; i++) {
            /* convert percentage to seconds */
            if( timemarks[i].indexOf('%') > 0 ) {
              timemarks[i] = (parseInt(timemarks[i], 10) / 100) * meta.durationsec;
            }
            if (parseInt(timemarks[i], 10) > (meta.durationsec * 0.9)) {
              // remove timemark from array
              timemarks.splice(i, 1);
            }
          }
          // if there are no more timemarks around, add one at end of the file
          if (timemarks.length === 0) {
            timemarks[0] = (meta.durationsec * 0.9);
          }
        }
        // get positions for screenshots (using duration of file minus 10% to remove fade-in/fade-out)
        var secondOffset = (meta.durationsec * 0.9) / screenshotcount;
        var donecount = 0;
        var series = [];

        // reset iterator
        var j = 1;

        var filenames = [];

        // use async helper function to generate all screenshots and
        // fire callback just once after work is done
        async.until(
          function() {
            return j > screenshotcount;
          },
          function(taskcallback) {
            var offset;
            if (timemarks !== null) {
              // get timemark for current iteration
              offset = timemarks[(j - 1)];
            } else {
              offset = secondOffset * j;
            }
            var fname = _renderOutputName(j, offset) + '.jpg';
            var target = self.escapedPath(folder + '/' + fname);
            var input = self.escapedPath(self.options.inputfile);

            // build screenshot command
            var command = [
              self.ffmpegPath,
              [
                '-ss', offset,
                '-i', input,
                '-vcodec', 'mjpeg',
                '-vframes', '1',
                '-an',
                '-f', 'rawvideo',
                '-s', self.options.video.size,
                '-y', target
                ].join(' ')
            ];

            j++;

            // only set niceness if running on a non-windows platform
            if (self.options.hasOwnProperty('_nice.level') && !os.match(/win(32|64)/)) {
              // execute ffmpeg through nice
              command.unshift('nice -n', self.options._nice.level||0);
            }

            exec(command.join(' '), taskcallback);
            filenames.push(fname);
          },
          function(err) {
            callback(err, filenames);
          }
        );
      });
    }

    var timemarks, screenshotcount, filename;
    if (typeof config === 'object') {
      // use json object as config
      if (config.count) {
        screenshotcount = config.count;
      }
      if (config.timemarks) {
        timemarks = config.timemarks;
      }
    } else {
      // assume screenshot count as parameter
      screenshotcount = config;
      timemarks = null;
    }
    if (!this.options.video.size) {
      this.options.logger.warn("set size of thumbnails using 'withSize' method");
      callback(new Error("set size of thumbnails using 'withSize' method"));
    }
    
    filename = config.filename || 'tn_%ss';
    if(!/%0*i/.test(filename) && timemarks.length > 1 ) {
      // if there are multiple timemarks but no %i in filename add one
      // so we won't overwrite the same thumbnail with each timemark
      filename += '_%i'; 
    }
    folder = folder || '.';
    
    var self = this;

    // WORKAROUND: exists will be moved from path to fs with node v0.7
    var check = fs.exists;
    if (!check) {
      check = path.exists;
    }

    // check target folder
    check(folder, function(exists) {
      if (!exists) {
        fs.mkdir(folder, '0755', function(err) {
          if (err !== null) {
            callback(err);
          } else {
            _screenShotInternal(callback);
          }
        });
      } else {
        _screenShotInternal(callback);
      }
    });
  };

  this._getProgressFromStdErr = function(stderrString, totalDurationSec) {
    // get last stderr line
    var lastLine = stderrString.split(/\r\n|\r|\n/g);
    var ll = lastLine[lastLine.length - 2];
    var progress = ll.split(/frame=([0-9\s]+)fps=([0-9\s]+)q=([0-9\.\s]+)(L?)size=([0-9\s]+)kB time=(([0-9]{2}):([0-9]{2}):([0-9]{2}).([0-9]{2})) bitrate=([0-9\.\s]+)kbits/ig);
    if (progress && progress.length > 10) {
      // build progress report object
      var ret = {
        frames: parseInt(progress[1], 10),
        currentFps: parseInt(progress[2], 10),
        currentKbps: parseFloat(progress[10]),
        targetSize: parseInt(progress[5], 10),
        timemark: progress[6]
      };

      // calculate percent progress using duration
      if (totalDurationSec && totalDurationSec > 0) {
        ret.percent = (this.ffmpegTimemarkToSeconds(ret.timemark) / totalDurationSec) * 100;
      }

      this.options.onProgress(ret);
    }
  };

  this._checkStdErrForCodec = function(stderrString) {
    var audio = /Audio\: ([^,]+)/.exec(stderrString);
    var video = /Video\: ([^,]+)/.exec(stderrString);
    var codecObject = { audio: '', video: '' };

    if (audio && audio.length > 1) {
      codecObject.audio = audio[1];
    }
    if (video && video.length > 1) {
      codecObject.video = video[1];
    }

    var codecInfoPassed = /Press \[q\] to stop/.test(stderrString);
    if (codecInfoPassed) {
      this.options.onCodecData(codecObject);
      this.options.onCodecData = null;
    }
  };

  this._spawnProcess = function(args, options) {
    var retProc = spawn(this.ffmpegPath, args, options);
    // only re-nice if running on a non-windows platform
    if (this.options.hasOwnProperty('_nice.level') && !os.match(/win(32|64)/)) {
      var niceLevel = this.options._nice.level || 0;
      if (niceLevel > 0) {
        niceLevel = '+' + niceLevel;
      }
      // renice the spawned process without waiting for callback
      var self = this;
      var command = [
        'renice -n', niceLevel,
        '-p', retProc.pid
      ].join(' ');

      exec(command, function(err, stderr, stdout) {
        if (!err) {
          self.options.logger.info('successfully reniced process ' + retProc.pid + ' to ' + niceLevel + ' niceness!');
        }
      });
    }
    if (retProc.stderr) {
      retProc.stderr.setEncoding('utf8');
    }
    return retProc;
  };

  this.buildFfmpegArgs = function(overrideOutputCheck, meta) {
    var args = [];

    // add startoffset and duration
    if (this.options.starttime) {
      args.push('-ss', this.options.starttime);
    }

    // add input file (if using fs mode)
    if (this.options.inputfile && !this.options.inputstream) {
      if (/^[a-z]+:\/\//.exec(this.options.inputfile)) {
        args.push('-i', this.options.inputfile.replace(' ', '%20'));
      } else {
        var fstats = fs.statSync(this.options.inputfile);
        if (fstats.isFile()) {
          // fix for spawn call with path containing spaces
          args.push('-i', this.options.inputfile.replace(' ', '\\ '));
        } else {
          this.options.logger.error('input file is not readable');
          throw new Error('input file is not readable');
        }
      }
    // check for input stream
    } else if (this.options.inputstream) {
      // push args to make ffmpeg read from stdin
      args.push('-i', '-');
    }

    if (this.options.duration) {
      args.push('-t', this.options.duration);
    }

    // add format
    if (this.options.format) {
      args.push('-f', this.options.format);
    }

    // add video options
    if (this.options.video.skip) {
      // skip video stream completely (#45)
      args.push('-vn');
    } else {
      if (this.options.video.bitrate) {
        args.push('-b', this.options.video.bitrate + 'k');
        if (this.options._useConstantVideoBitrate) {
          // add parameters to ensure constant bitrate encoding
          args.push('-maxrate', this.options.video.bitrate + 'k');
          args.push('-minrate', this.options.video.bitrate + 'k');
          args.push('-bufsize', '3M');
        }
      } else {
        // use same quality for output as used in input
        args.push('-sameq');
      }
      if (this.options.video.codec) {
        args.push('-vcodec', this.options.video.codec);
      }
      if (this.options.video.fps) {
        args.push('-r', this.options.video.fps);
      }
      if (this.options.video.aspect) {
        args.push('-aspect', this.options.video.aspect);
      }
    }

    // add video options
    if (this.options.audio.skip) {
      // skip audio stream completely (#45)
      args.push('-an');
    } else {
      if (this.options.audio.bitrate) {
        args.push('-ab', this.options.audio.bitrate + 'k');
      }
      if (this.options.audio.channels) {
        args.push('-ac', this.options.audio.channels);
      }
      if (this.options.audio.codec) {
        args.push('-acodec', this.options.audio.codec);
      }
      if (this.options.audio.frequency) {
        args.push('-ar', this.options.audio.frequency);
      }
    }

    // add additional options
    if (this.options.additional) {
      if (this.options.additional.length > 0) {
        this.options.additional.forEach(function(el) {
          args.push(el);
        });
      }
    }

    if (this.options.video.pad && !this.options.video.skip) {
      // we have padding arguments, push
      if (this.atLeastVersion(meta.ffmpegversion, '0.7')) {
        // padding is not supported ffmpeg < 0.7 (only using legacy commands which were replaced by vfilter calls)
        args.push('-vf');
        args.push('pad=' + this.options.video.pad.w +
          ':' + this.options.video.pad.h +
          ':' + this.options.video.pad.x +
          ':' + this.options.video.pad.y +
          ':' + this.options.video.padcolor);
      } else {
        return new Error("Your ffmpeg version " + meta.ffmpegversion + " does not support padding");
      }
    }

    // add size and output file
    if (this.options.video.size && !this.options.video.skip) {
      args.push('-s', this.options.video.size);
    }


    if (this.options.outputfile) {
      args.push('-y', this.options.outputfile.replace(' ', '\\ '));
    } else {
      if (!overrideOutputCheck) {
        this.options.logger.error('no outputfile specified');
      }
    }
//console.log(args);
    return args;
  };
};

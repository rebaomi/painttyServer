var util = require("util");
var net = require('net-cluster');
var Buffers = require('buffers');
var _ = require('underscore');
var logger = require('tracer').dailyfile({root:'./logs'});
var common = require('./common.js');
var Transform = require('stream').Transform;
var PassThrough = require('stream').PassThrough;

function StreamedSocketProtocol(options) {
  Transform.call(this, options);

  var defaultOptions = {
    client: null
  };
  
  if(_.isUndefined(options)) {
    var options = {};
  }
  var op = _.defaults(options, defaultOptions);

  this._options = op;
  this._client = op.client;
  this._buf = new Buffers();
  this._dataSize = null;
}

function protocolPack(data) {
  var len = data.length;
  var c1, c2, c3, c4;
  var tmp = new Buffer(4);
  c1 = len & 0xFF;
  len >>= 8;
  c2 = len & 0xFF;
  len >>= 8;
  c3 = len & 0xFF;
  len >>= 8;
  c4 = len & 0xFF;
  tmp[0] = c4;
  tmp[1] = c3;
  tmp[2] = c2;
  tmp[3] = c1;
  return Buffer.concat([tmp, data], 4+data.length);
};

StreamedSocketProtocol.prototype._transform = function(chunk, encoding, done) {
  var stream_protocol = this;
  stream_protocol._buf.push(chunk);
  
  function GETPACKAGESIZEFROMDATA() {
    var pg_size_array = stream_protocol._buf.splice(0, 4);
    pg_size_array = pg_size_array.toBuffer();
    var pg_size = (pg_size_array[0] << 24) + (pg_size_array[1] << 16) + (pg_size_array[2] << 8) + pg_size_array[3];
    return pg_size;
  }
  
  function READRAWBYTES(size) {
    var data = stream_protocol._buf.splice(0, size);
    data = data.toBuffer();
    return data;
  }
  
  function REBUILD(rawData) {
    return protocolPack(rawData);
  }
  
  function GETFLAG(pkgData) {
    return pkgData[0] === 0x1;
  }
  
  while (true) {
    if(stream_protocol._dataSize === 0){
      if (stream_protocol._buf.length < 4){
        done();
        return;
      }
      stream_protocol._dataSize = GETPACKAGESIZEFROMDATA();
    }
    if (stream_protocol._buf.length < stream_protocol._dataSize){
      done();
      return;
    }
    var packageData = READRAWBYTES(stream_protocol._dataSize);
    var isCompressed = GETFLAG(packageData);
    var dataBlock = packageData.slice(1);
    
    var repacked = REBUILD(packageData);
    stream_protocol.emit('datapack', stream_protocol._client, repacked);
    
    stream_protocol.push(repacked);
    stream_protocol._dataSize = 0;
  }

  done();
};


function SocketServer(options) {
  net.Server.call(this);
  
  var defaultOptions = {
    autoBroadcast: true,
    compressed: true,
    keepAlive: true,
    indebug: false
  };
  
  if(_.isUndefined(options)) {
    var options = {};
  }
  var op = _.defaults(options, defaultOptions);
  
  var server = this;
  server.options = op;
  server.clients = [];
  server.on('connection', function(cli) {
    cli.setKeepAlive(server.options.keepAlive);
    server.clients.push(cli);
    cli.on('close', function() {
      var index = server.clients.indexOf(cli);
      server.clients.splice(index, 1);
    }).on('error', function(err) {
      logger.error('Error with socket:', err);
      cli.destroy();
      var index = server.clients.indexOf(cli);
      server.clients.splice(index, 1);
    });

    var stream_parser = new StreamedSocketProtocol({'client': cli});

    if (op.autoBroadcast) {
      var server.passthrogh = new PassThrough();
      cli.pipe(stream_parser, { end: false }).pipe(passthrogh);
      _.each(server.clients, function(c) {
        if(c != cli) passthrogh.pipe(c);
      });
    }else{
      cli.pipe(stream_parser, { end: false });
    };
  }).on('error', function(err) {
    logger.error('Error with socket:', err);
  });
}

util.inherits(SocketServer, net.Server);

SocketServer.prototype.sendData = function (cli, data, fn) {
  var server = this;
  if(server.options.compressed === true){
    common.qCompress(data, function(d) {
      var tmpData = new Buffer(1);
      tmpData[0] = 0x1;
      var r_data = Buffer.concat([tmpData, d]);
      if ( _.isFunction(fn) ) {
        cli.write( protocolPack(r_data), fn );
      }else{
        cli.write( protocolPack(r_data) );
      }
    });
  }else{
    var tmpData = new Buffer(1);
    tmpData[0] = 0x0;
    var r_data = Buffer.concat([tmpData, data]);
    if ( _.isFunction(fn) ) {
      cli.write( protocolPack(r_data), fn );
    }else{
      cli.write( protocolPack(r_data) );
    }
  }
};

SocketServer.prototype.broadcastData = function (data) {
  var server = this;
  _.each(server.clients, function(cli) {
    server.sendData(cli, data);
  });
};

SocketServer.prototype.kick = function(cli) {
  var server = this;
  cli.end();
};

exports.SocketServer = SocketServer;

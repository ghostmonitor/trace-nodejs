var https = require('https')
var url = require('url')
var util = require('util')
var requestSync = require('sync-request')
var debug = require('debug')('risingstack/trace')
var format = require('util').format

var bl = require('bl')
var libPackage = require('../../../package')

function TraceReporter (options) {
  this.COLLECTOR_API_SAMPLE = url.resolve(options.collectorApiUrl,
    options.collectorApiSampleEndpoint)
  this.COLLECTOR_API_SERVICE = url.resolve(options.collectorApiUrl,
    options.collectorApiServiceEndpoint)
  this.COLLECTOR_API_METRICS = url.resolve(options.collectorApiUrl,
    options.collectorApiApmMetricsEndpoint)
  this.COLLECTOR_API_RPM_METRICS = url.resolve(options.collectorApiUrl,
    options.collectorApiRpmMetricsEndpoint)

  this.apiKey = options.apiKey
  this.serviceName = options.serviceName
  this.baseRetryInterval = 100
  this.retryCount = 0
  this.retryLimit = 13

  // check if everything is ok with config
  if (!this.apiKey) {
    throw new Error('Missing apiKey')
  }

  if (!this.serviceName) {
    throw new Error('Missing serviceName')
  }
}

TraceReporter.prototype.setEventBus = function (eventBus) {
  this.eventBus = eventBus
  this.eventBus.on(this.eventBus.HTTP_TRANSACTION_STACK_TRACE, this.sendSync.bind(this))
  this.eventBus.on(this.eventBus.HTTP_TRANSACTION, this.sendHttpTransactions.bind(this))
  this.eventBus.on(this.eventBus.RPM_METRICS, this.sendRpmMetrics.bind(this))
  this.eventBus.on(this.eventBus.APM_METRICS, this.sendApmMetrics.bind(this))
  this.getService()
}

// USE THIS WITH CAUTION, IT WILL BE BLOCKING
TraceReporter.prototype.sendSync = function (data) {
  debug('sending data to trace servers sync: ', JSON.stringify(data))
  requestSync('POST', this.COLLECTOR_API_SAMPLE, {
    json: data,
    headers: {
      'Authorization': 'Bearer ' + this.apiKey,
      'Content-Type': 'application/json',
      'X-Reporter-Version': libPackage.version
    },
    timeout: 1000
  })
}

TraceReporter.prototype._send = function (destinationUrl, data) {
  var opts = url.parse(destinationUrl)
  var payload = JSON.stringify(data)

  var req = https.request({
    hostname: opts.hostname,
    port: opts.port,
    path: opts.path,
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + this.apiKey,
      'Content-Type': 'application/json',
      'X-Reporter-Version': libPackage.version,
      'Content-Length': payload.length
    }
  }, function (res) {
    res.setEncoding('utf8')
    res.pipe(bl(function (err) {
      if (err) {
        debug('There was an error when connecting to the Trace API', err)
        return
      }

      debug('HTTP Traces sent successfully')
    }))
  })

  debug('sending data to trace servers: ', payload)
  req.write(payload)
  req.end()
}

TraceReporter.prototype.sendRpmMetrics = function (data) {
  if (isNaN(this.serviceId)) {
    debug('Service id not present, cannot send rpm metrics')
    return
  }

  var url = util.format(this.COLLECTOR_API_RPM_METRICS, this.serviceId)
  this._send(url, data)
}

TraceReporter.prototype.sendApmMetrics = function (data) {
  if (isNaN(this.serviceId)) {
    debug('Service id not present, cannot send metrics')
    return
  }

  var url = util.format(this.COLLECTOR_API_METRICS, this.serviceId)
  this._send(url, data)
}

TraceReporter.prototype.sendHttpTransactions = function (data) {
  var url = this.COLLECTOR_API_SAMPLE
  this._send(url, data)
}

TraceReporter.prototype._getRetryInterval = function () {
  var retryInterval = Math.pow(2, this.retryCount) * this.baseRetryInterval
  debug('retrying with %d ms', retryInterval)
  return retryInterval
}

TraceReporter.prototype.getService = function () {
  debug('getting service id from the trace servers')

  var opts = url.parse(this.COLLECTOR_API_SERVICE)
  var _this = this

  var payload = JSON.stringify({
    name: _this.serviceName
  })

  var req = https.request({
    hostname: opts.hostname,
    port: opts.port,
    path: opts.path,
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + this.apiKey,
      'Content-Type': 'application/json',
      'X-Reporter-Version': libPackage.version,
      'Content-Length': payload.length
    }
  }, function (res) {
    res.setEncoding('utf8')
    res.pipe(bl(function (err, resBuffer) {
      var response

      if (err) {
        debug('There was an error when connecting to the Trace API, retrying', err)
        if (++_this.retryCount < _this.retryLimit) {
          return setTimeout(function () {
            _this.getService()
          }, _this._getRetryInterval())
        }
        return debug('The trace collector-api is currently unavailable', err)
      }

      var resText = resBuffer.toString('utf8')

      debug('raw response from trace servers: ', resText)
      if (res.statusCode === 401) {
        return console.error(format('%s trace: error: %s', new Date(), 'TRACE_API_KEY got rejected - are you sure you are using the right one?'))
      }
      if (res.statusCode > 399) {
        if (++_this.retryCount < _this.retryLimit) {
          return setTimeout(function () {
            _this.getService()
          }, _this._getRetryInterval())
        }

        return _this.eventBus.emit(_this.eventBus.ERROR,
                                   'The trace collector-api is currently unavailable')
      }

      try {
        response = JSON.parse(resText)
      } catch (ex) {
        debug('Error parsing JSON:', ex)
        return debug(ex)
      }

      _this.serviceId = response.key
      return _this.eventBus.emit(_this.eventBus.TRACE_SERVICE_KEY, response.key)
    }))
  })

  req.write(payload)
  req.end()
}

function create (options) {
  return new TraceReporter(options)
}

module.exports.create = create

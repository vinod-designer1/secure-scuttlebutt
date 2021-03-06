var ref       = require('ssb-ref')
var path      = require('path')
var Follower  = require('../follower')
var pull      = require('pull-stream')
var ltgt      = require('ltgt')
var ssbKeys   = require('ssb-keys')
var paramap   = require('pull-paramap')

//53 bit integer
var MAX_INT  = 0x1fffffffffffff
var u = require('../util')

var mlib = require('ssb-msgs')

function isString (s) {
  return 'string' === typeof s
}

module.exports = function (db, keys) {

  function indexMsg (add, localtime, id, msg) {
    //DECRYPT the message, if possible
    //to enable indexing. If external apis
    //are not provided that may access indexes
    //then this will not leak information.
    //otherwise, we may need to figure something out.

    var content = (keys && isString(msg.content))
      ? ssbKeys.unbox(msg.content, keys)
      : msg.content

    if(!content) return

    if(isString(content.type))
      add({
        key: ['type', content.type.toString().substring(0, 32), localtime],
        value: id, type: 'put'
      })

    mlib.indexLinks(content, function (obj, rel) {
      add({
        key: ['link', msg.author, rel, obj.link, msg.sequence, id],
        value: obj,
        type: 'put'
      })
      add({
        key: ['_link', obj.link, rel, msg.author, msg.sequence, id],
        value: obj,
        type: 'put'
      })
    })
  }


  var indexPath = path.join(db.location, 'links')
  var index = Follower(db, indexPath, 1, function (data) {
    if(data.sync) return
    var msg = data.value
    var id = data.key

    var a = []
    indexMsg(function (op) { a.push(op) }, data.timestamp, id, msg)
    return a
  })

  index.messagesByType = function (opts) {
    if(!opts)
      throw new Error('must provide {type: string} to messagesByType')

    if(isString(opts))
      opts = {type: opts}

    opts = u.options(opts)
    var _keys   = opts.keys
    var _values = opts.values
    opts.values = true

    ltgt.toLtgt(opts, opts, function (value) {
      return ['type', opts.type, value]
    }, u.lo, u.hi)

    return pull(
      index.read(opts),
      paramap(function (data, cb) {
        if(data.sync) return cb()
        var id = _keys ? data.value : data
        db.get(id, function (err, msg) {
          var ts = opts.keys ? data.key[2] : undefined
          cb(null, u.format(_keys, _values, {key: id, ts: ts, value: msg}))
        })
      }),
      pull.filter()
    )
  }

  function format(opts, op, key, value) {
    var meta = opts.meta !== false  //default: true
    var keys = opts.keys !== false  //default: true
    var vals = opts.values === true //default: false
    if(!meta&&!keys&&!vals)
      throw new Error('a stream without any values does not make sense')
    if(!meta) return (
          keys && vals  ? {key: op.key, value: value}
        : keys          ? op.key
                        : value
      )
    else {
      if(vals)  op.value = value
      if(!keys) delete op.key
      delete op._value
      return op
    }
  }

  function type(t) { return {feed: '@', msg: '%', blob: '&'}[t] || t }

  function linksOpts (opts) {
    if(!opts) throw new Error('opts *must* be provided')

    if(  !(opts.values === true)
      && !(opts.meta !== false)
      && !(opts.keys !== false)
    )
      throw new Error('makes no sense to return stream without results'
        + 'set at least one of {keys, values, meta} to true')

    var src = type(opts.source), dst = type(opts.dest), rel = opts.rel

    var back = dst && !src
    var from = back ? dst : src, to = back ? src : dst

    function range(value, end, def) {
      return !value ? def : /^[@%&]$/.test(value) ? value + end : value
    }
    function lo(value) { return range(value, "!", u.lo) }
    function hi(value) { return range(value, "~", u.hi) }

    var index = back ? '_link' : 'link'
    var gte = [index, lo(from), rel || u.lo, lo(to), u.lo, u.lo]
    var lte = [index, hi(from), rel || u.hi, hi(to), u.hi, u.hi]
    return {
      gte: gte, lte: lte, reverse: opts.reverse,
      back: back, rel: rel, source: src, dest: dst,
      live: opts.live, sync: opts.sync, old: opts.old,
      props: {
        keys: opts.keys !== false, //default: true
        meta: opts.meta !== false, //default: true
        values: opts.values === true, //default: false
      }
    }
  }

  function testLink (a, e) { //actual, expected
    return e ? e.length === 1 ? a[0]==e[0] : a===e : true
  }

  function lookupLinks (opts) {
    return pull(
      pull.map(function (op) {
        if(op.sync) return op
        return {
          _value: op._value,
          source: op.key[opts.back?3:1],
          rel: op.key[2],
          dest: op.key[opts.back?1:3],
          key: op.key[5]
        }
      }),
      // in case source and dest are known but not rel,
      // this will scan all links from the source
      // and filter out those to the dest. not efficient
      // but probably a rare query.
      pull.filter(function (data) {
        if(data.sync) return true
        if(opts.rel && opts.rel !== data.rel) return false
        if(!testLink(data.dest, opts.dest)) return false
        if(!testLink(data.source, opts.source)) return false
        return true
      }),
      ! opts.props.values
      ? pull.map(function (op) {
          if(op.sync) return op
          return format(opts.props, op, op.key, null)
        })
      : paramap(function (op, cb) {
          if(op.sync) return cb(null, op)
          if(op._value)
            return cb(null, format(opts.props, op, op.key, op._value))
          db.get(op.key, function (err, msg) {
            if(err) return cb(err)
            cb(null, format(opts.props, op, op.key, msg))
          })
      })
    )
  }


  index.links = function (opts) {
    opts = linksOpts(opts)
    return pull(
      index.read(opts),
      lookupLinks(opts)
    )
  }

  return index

}


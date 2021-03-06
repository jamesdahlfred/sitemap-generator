'use strict';

var http = require('http');
var url = require('url');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var Crawler = require('simplecrawler');
var cheerio = require('cheerio');
var xmlbuilder = require('xmlbuilder');
var assign = require('lodash.assign');
var forIn = require('lodash.forin');
var chunk = require('lodash.chunk');

/**
 * Builds an URL string from a parsed URL Object.
 *
 * @return {String} stringified URL
 */
function stringifyUrl(parsedUrl) {
  return parsedUrl.protocol + '://' + parsedUrl.host + parsedUrl.uriPath;
}

/**
 * Builds XML markup for given URLs.
 *
 * @return {String} XML markup
 */
function generateSitemap(urls) {
  // xml base
  var xml = xmlbuilder.create('urlset', { version: '1.0', encoding: 'UTF-8' })
    .att('xmlns', 'http://www.sitemaps.org/schemas/sitemap/0.9');

  // add elements
  forIn(urls, function (u) {
    xml.ele('url')
      .ele({
        loc: u,
      });
  });

  // finish xml markup
  return xml.end({ pretty: true, indent: '  ', newline: '\n' });
}

/**
 * Create XML markup for an sitemap index file.
 *
 * @return {String} XML markup
 */
function generateSitemapIndex(baseUrl, count) {
  // xml base
  var xml = xmlbuilder.create('sitemapindex', { version: '1.0', encoding: 'UTF-8' })
    .att('xmlns', 'http://www.sitemaps.org/schemas/sitemap/0.9');

  var i;
  for (i = 1; i <= count; i++) {
    xml.ele('sitemap')
      .ele({
        loc: url.resolve(baseUrl, 'sitemap_part' + i + '.xml'),
      });
  }

  // finish xml markup
  return xml.end({ pretty: true, indent: '  ', newline: '\n' });
}

/**
 * Generator object, handling the crawler and sitemap generation.
 *
 * @param  {String} uri       URL to parse
 * @param  {Object} options   various options
 */
function SitemapGenerator(uri, options) {
  var self = this;

  // defaults
  var defaultOptions = {
    stripQuerystring: true,
    restrictToBasepath: false,
    maxEntriesPerFile: 50000,
    crawlerMaxDepth: 0,
  };

  // excluded filetypes
  var exclude = ['gif', 'jpg', 'jpeg', 'png', 'ico', 'bmp', 'ogg', 'webp',
    'mp4', 'webm', 'mp3', 'ttf', 'woff', 'json', 'rss', 'atom', 'gz', 'zip',
    'rar', '7z', 'css', 'js', 'gzip', 'exe', 'svg'];
  var exts = exclude.join('|');
  var extRegex = new RegExp('\\.(' + exts + ')$', 'i');

  // throw error if no baseUrl is provided
  if (!uri) {
    throw new TypeError('First parameter \'uri\' is required!');
  }

  // set default status
  this.status = 'idle';

  // assign default options
  this.options = assign({}, defaultOptions, options);

  // store for discovered ressources
  this.store = {
    error: [],
    found: [],
    ignored: [],
  };

  // prepend protocol if not provided
  var baseUrl = uri;
  if (!/^https?:\/\//.test(uri)) {
    baseUrl = 'http://' + baseUrl;
  }

  // create URL object
  this.baseUrl = url.parse(baseUrl);

  // create Crawler
  this.crawler = new Crawler(this.baseUrl.href);

  // set initial path to subpage if provided
  var initialPath = '/';
  if (this.baseUrl.pathname) {
    initialPath = this.baseUrl.pathname;
  }
  // set initial path
  this.crawler.initialPath = initialPath;

  // Set maxDepth if applicable
  this.crawler.maxDepth = this.options.crawlerMaxDepth;

  // decode responses
  this.crawler.decodeResponses = true;

  // respect robots txt rules
  this.crawler.respectRobotsTxt = true;

  // set initial protocol
  this.crawler.initialProtocol = this.baseUrl.protocol.replace(':', '');

  // set user agent
  this.crawler.userAgent = 'Node/SitemapGenerator';

  // pass query string handling option to crawler
  this.crawler.stripQuerystring = this.options.stripQuerystring;

  // restrict crawler to subpages if initial page is privided
  if (this.options.restrictToBasepath) {
    this.crawler.addFetchCondition(function (parsedUrl) {
      var baseUrlPath = url.resolve(self.baseUrl.hostname, self.baseUrl.pathname);
      var baseUrlRegex = new RegExp(baseUrlPath + '.*');
      return stringifyUrl(parsedUrl).match(baseUrlRegex);
    });
  }

  // file type exclusion
  this.crawler.addFetchCondition(function (parsedUrl) {
    return !parsedUrl.path.match(extRegex);
  });

  // array with urls that are crawled but shouldn't be indexed
  this.crawler.noindex = [];

  // custom discover function
  this.crawler.discoverResources = this._discoverResources;

  // register event handlers and emit own events
  this.crawler.on('fetch404', function (queueItem) {
    self.store.error.push({ url: queueItem.url, referrer: queueItem.referrer });
    self.emit('fetch', http.STATUS_CODES['404'], queueItem);
  });

  this.crawler.on('fetchtimeout', function (queueItem, response) {
    self.store.error.push({ url: queueItem.url, referrer: queueItem.referrer });
    self.emit('fetch', http.STATUS_CODES['408'], response);
  });

  this.crawler.on('clienterror', function (queueError, errorData) {
    self.emit('clienterror', queueError, errorData);
  });

  this.crawler.on('fetchdisallowed', function (queueItem) {
    if (self.store.ignored.indexOf(queueItem.url) === -1) {
      self.store.ignored.push(queueItem.url);
      self.emit('ignore', queueItem);
    }
  });

  // fetch complete event
  this.crawler.on('fetchcomplete', function (queueItem) {
    self.store.found.push(queueItem.url);
    self.emit('fetch', http.STATUS_CODES['200'], queueItem);
  });

  // crawler done event
  this.crawler.on('complete', this._buildXML.bind(this, function (sitemap) {
    // update status
    this.status = 'idle';

    // emit done event
    this.emit('done', sitemap, this.store);
  }));

  EventEmitter.call(this);
}

util.inherits(SitemapGenerator, EventEmitter);

/**
 * Parses response data for links.
 */
SitemapGenerator.prototype._discoverResources = function (buffer, queueItem) {
  var $ = cheerio.load(buffer.toString('utf8'));

  // cancel if meta robots nofollow is present
  var metaRobots = $('meta[name="robots"]');

  // add to noindex for it later to be removed from the store before a sitemap is built
  if (metaRobots.length && /noindex/i.test(metaRobots.attr('content'))) {
    this.noindex.push(queueItem.url);
  }

  if (metaRobots.length && /nofollow/i.test(metaRobots.attr('content'))) {
    return [];
  }

  // parse links
  var links = $('a[href]').map(function () {
    var href = $(this).attr('href');

    // exclude "mailto:" etc
    if (/^[a-z]+:(?!\/\/)/i.test(href)) {
      return null;
    }

    // exclude rel="nofollow" links
    var rel = $(this).attr('rel');
    if (/nofollow/i.test(rel)) {
      return null;
    }

    // remove anchors
    href = href.replace(/(#.*)$/, '');

    // handle "//"
    if (/^\/\//.test(href)) {
      return queueItem.protocol + ':' + href;
    }

    // check if link is relative
    // (does not start with "http(s)" or "//")
    if (!/^https?:\/\//.test(href)) {
      var base = $('base').first();
      if (base.length) {
        // base tag is set, prepend it
        href = url.resolve(base.attr('href'), href);
      }

      // handle links such as "./foo", "../foo", "/foo"
      if (/^\.\.?\/.*/.test(href) || /^\/[^\/].*/.test(href)) {
        href = url.resolve(queueItem.url, href);
      }
    }

    return href;
  });

  return links.get();
};

/**
 * Creates the XML markup.
 *
 * @param  {Function} callback Callback function to execute
 */
SitemapGenerator.prototype._buildXML = function (callback) {
  var sitemaps = null;

  if (this.store.found.length > 0 && this.store.found.length !== this.crawler.noindex.length) {
    // Remove urls with a robots meta tag 'noindex' before building the sitemap
    this.crawler.noindex.forEach(function (page) {
      var index = this.store.found.indexOf(page);
      if (index !== -1) {
        // remove url from found array
        var ignored = this.store.found.splice(index, 1)[0];
        // add url to ignored url
        this.store.ignored.push(ignored);
      }
    }, this);

    var parts = chunk(this.store.found, this.options.maxEntriesPerFile);
    sitemaps = parts.reduce(function (maps, part) {
      maps.push(generateSitemap(part));
      return maps;
    }, []);

    if (parts.length > 1) {
      var baseUrl = this.baseUrl.protocol + '//' + this.baseUrl.hostname;
      sitemaps.unshift(generateSitemapIndex(baseUrl, parts.length));
    }
  }

  if (typeof callback === 'function') {
    callback.call(this, sitemaps);
  }
};

/**
 * Starts the crawler.
 */
SitemapGenerator.prototype.start = function () {
  if (this.status === 'crawling') {
    throw new Error('This SitemapGenerator instance is already crawling a site.');
  }

  // update status
  this.status = 'crawling';

  // start the crawler
  this.crawler.start();

  return this;
};

module.exports = SitemapGenerator;

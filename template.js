const encodeUriComponent = require('encodeUriComponent');
const generateRandom = require('generateRandom');
const getAllEventData = require('getAllEventData');
const getCookieValues = require('getCookieValues');
const getRequestHeader = require('getRequestHeader');
const getTimestampMillis = require('getTimestampMillis');
const getType = require('getType');
const JSON = require('JSON');
const makeNumber = require('makeNumber');
const makeString = require('makeString');
const Object = require('Object');
const sendHttpRequest = require('sendHttpRequest');
const setCookie = require('setCookie');
const sha256Sync = require('sha256Sync');

/*==============================================================================
==============================================================================*/

const eventData = getAllEventData();
const PIWIK_PARAM_PREFIX = 'x-pp-';
const QUERY_STRING_LENGTH_LIMIT = 2048;

if (shouldExitEarly(data, eventData)) return;

const eventNameData = getEventNameData();
const ecommerceEventType = getEcommerceEventType();
let endpoint = getTrackingUrl(data);
const params = getPiwikParams();

if (data.parametersToOverride && data.parametersToOverride.length) {
  data.parametersToOverride.forEach((param) => {
    if (isValidValue(param.value)) {
      params[param.name] = param.value;
    }
  });
}

const queryParamsString = objectToQueryString(params);
const usePostRequest = queryParamsString.length > QUERY_STRING_LENGTH_LIMIT;
const headers = {
  'Content-Type': usePostRequest ? 'application/json' : 'text/plain;charset=UTF-8'
};
let requestBody;

if (usePostRequest) {
  requestBody = JSON.stringify({ requests: ['?' + queryParamsString] });
} else if (queryParamsString) {
  endpoint = endpoint + '?' + queryParamsString;
}

if (data.requestHeaders && data.requestHeaders.length) {
  data.requestHeaders.forEach((header) => {
    if (usePostRequest && makeString(header.name).toLowerCase() === 'content-type') return;
    headers[header.name] = header.value;
  });
}

sendHttpRequest(
  endpoint,
  {
    headers: headers,
    method: usePostRequest ? 'POST' : 'GET'
  },
  requestBody
)
  .then((response) => {
    if (!data.useOptimisticScenario) {
      if (response.statusCode >= 200 && response.statusCode < 300) {
        data.gtmOnSuccess();
      } else {
        data.gtmOnFailure();
      }
    }
  })
  .catch(() => {
    if (!data.useOptimisticScenario) {
      data.gtmOnFailure();
    }
  });

if (data.useOptimisticScenario) {
  data.gtmOnSuccess();
}

/*==============================================================================
Vendor related functions
==============================================================================*/
function getTrackingUrl(data) {
  let trackingUrl = makeString(data.trackingUrl).trim();
  if (trackingUrl.indexOf('ppms.php', trackingUrl.length - 10) === -1) {
    if (trackingUrl.slice(-1) !== '/') trackingUrl = trackingUrl + '/';
    trackingUrl = trackingUrl + 'ppms.php';
  }
  return trackingUrl;
}

function getEventNameData() {
  if (data.eventType === 'inherit') {
    if (
      eventData.event_name === 'page_view' ||
      eventData.event_name === 'Data' ||
      !eventData.event_name
    ) {
      return { isPageView: true };
    }

    return {
      isPageView: false,
      e_c: getPrefixedParam('e_c') || eventData.event_category,
      e_a: getPrefixedParam('e_a') || eventData.event_action,
      e_n: getPrefixedParam('e_n') || eventData.event_name
    };
  }

  if (data.eventTypeCustom === 'pageView') {
    return { isPageView: true };
  }

  return {
    isPageView: false,
    e_c: data.eventCategory,
    e_a: data.eventAction,
    e_n: data.eventName
  };
}

function getEcommerceEventType() {
  const GA4_TO_PIWIK_ECOMMERCE_EVENTS = {
    view_item: 'product-detail-view',
    add_to_cart: 'add-to-cart',
    remove_from_cart: 'remove-from-cart',
    view_cart: 'cart-update',
    begin_checkout: 'cart-update',
    add_shipping_info: 'cart-update',
    add_payment_info: 'cart-update',
    purchase: 'order'
  };

  if (!data.enableEcommerceTracking) return;
  if (isValidValue(data.e_t) && data.e_t !== 'inherit') return data.e_t;
  // Custom event setups only become ecommerce events when the type is set explicitly.
  if (data.eventType !== 'inherit') return;

  return (
    GA4_TO_PIWIK_ECOMMERCE_EVENTS[eventData.event_name] ||
    eventData[PIWIK_PARAM_PREFIX + 'e_t'] ||
    eventData.e_t
  );
}

function getVisitorId() {
  const piwikClientIdName = '_pk_.' + data.siteId;
  let piwikClientId =
    data._id ||
    getCookieValues(piwikClientIdName)[0] ||
    eventData._id ||
    eventData[PIWIK_PARAM_PREFIX + '_id'] ||
    eventData.client_id;

  if (!piwikClientId) {
    piwikClientId = getTimestampMillis() + '' + generateRandom(1000000000, 2147483647);
  }

  piwikClientId = normalizeVisitorId(piwikClientId);

  setCookie(piwikClientIdName, piwikClientId, {
    domain: 'auto',
    path: '/',
    sameSite: 'Lax',
    secure: true,
    'max-age': 34560000, // 400 days
    httpOnly: false
  });

  return piwikClientId;
}

function getPageViewId() {
  const ALPHANUMERIC = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const pageViewId = eventData.pv_id || eventData['x-ga-page_id'];

  if (!isValidValue(pageViewId)) return;

  if (isValidValue(eventData.pv_id) && hasOnlyChars(makeString(eventData.pv_id), 6, ALPHANUMERIC)) {
    return makeString(eventData.pv_id);
  }

  const stringPageViewId = makeString(pageViewId);

  return isHexString(stringPageViewId, 6)
    ? stringPageViewId
    : sha256Sync(stringPageViewId, { outputEncoding: 'hex' }).slice(0, 6);
}

function getSearchCategories() {
  const searchCategories = eventData.search_cats;
  if (getType(searchCategories) === 'array') {
    const categories = searchCategories
      .filter((category) => isValidValue(category))
      .map((category) => makeString(category));
    return categories.length ? categories : undefined;
  }
  if (isValidValue(searchCategories)) {
    const stringCategories = makeString(searchCategories).trim();
    if (stringCategories.indexOf('[') === 0) return stringCategories;
    const categories = stringCategories
      .split(',')
      .map((category) => category.trim())
      .filter((category) => !!category);
    return categories.length ? categories : undefined;
  }
  if (isValidValue(eventData.search_cat)) return [makeString(eventData.search_cat)];
}

function getCustomVariables(rows) {
  if (getType(rows) !== 'array') return;

  const customVariables = {};
  rows.forEach((row) => {
    if (!row || !isValidValue(row.id) || !isValidValue(row.name)) return;
    customVariables[makeString(row.id)] = [
      makeString(row.name),
      isValidValue(row.value) ? makeString(row.value) : ''
    ];
  });

  return Object.keys(customVariables).length ? customVariables : undefined;
}

function getCustomDimensions() {
  const customDimensions = {};
  if (getType(data.custom_dims) !== 'array') return customDimensions;

  data.custom_dims.forEach((dimension) => {
    if (!dimension || !isValidValue(dimension.index) || !isValidValue(dimension.value)) return;
    customDimensions['dimension' + makeString(dimension.index).trim()] = dimension.value;
  });

  return customDimensions;
}

function getAnonymousTrackingParams() {
  if (data.anonymous === 'uia') return { uia: 1 };
  if (data.anonymous === 'rmip') return { rmip: 1 };
  return {
    uia: eventData.uia,
    rmip: eventData.rmip
  };
}

function getPrefixedParam(key) {
  const value = eventData[PIWIK_PARAM_PREFIX + key];
  return isValidValue(value) ? value : undefined;
}

function getPiwikPrefixedParams() {
  return Object.keys(eventData).reduce((acc, key) => {
    if (key.match('^' + PIWIK_PARAM_PREFIX + '.+')) {
      acc[key.slice(PIWIK_PARAM_PREFIX.length)] = eventData[key];
    }
    return acc;
  }, {});
}

/*==============================================================================
Ecommerce
==============================================================================*/

function getEcommerceParams() {
  if (!ecommerceEventType) return getLegacyEcommerceParams();

  const isOrder = ecommerceEventType === 'order';
  const hasCartTotals = isOrder || ecommerceEventType === 'cart-update';

  return {
    e_t: ecommerceEventType,
    ec_products: getEcommerceProducts(),
    ec_id:
      data.ec_id ||
      getPrefixedParam('ec_id') ||
      (isOrder ? eventData.ec_id || eventData.transaction_id : undefined),
    revenue:
      data.revenue ||
      getPrefixedParam('revenue') ||
      (hasCartTotals ? eventData.revenue || eventData.value : undefined),
    ec_st:
      data.ec_st ||
      getPrefixedParam('ec_st') ||
      (hasCartTotals ? eventData.ec_st || eventData.value : undefined),
    ec_tx:
      data.ec_tx ||
      getPrefixedParam('ec_tx') ||
      (hasCartTotals ? eventData.ec_tx || eventData.tax : undefined),
    ec_sh:
      data.ec_sh ||
      getPrefixedParam('ec_sh') ||
      (hasCartTotals ? eventData.ec_sh || eventData.shipping : undefined),
    ec_dt:
      data.ec_dt ||
      getPrefixedParam('ec_dt') ||
      (hasCartTotals ? eventData.ec_dt || eventData.discount_amount : undefined)
  };
}

function getLegacyEcommerceParams() {
  const ui = data.enableEcommerceTracking ? data : {};
  const orderId =
    ui.ec_id || getPrefixedParam('ec_id') || eventData.ec_id || eventData.transaction_id;

  const sendLegacyGoal =
    data.enableEcommerceTracking && (data.eventType !== 'inherit' || isValidValue(orderId));

  return {
    idgoal: sendLegacyGoal ? 0 : eventData.idgoal,
    revenue: ui.revenue || getPrefixedParam('revenue') || eventData.revenue || eventData.value,
    ec_id: orderId,
    ec_items: isValidValue(ui.ec_products) ? normalizeProducts(ui.ec_products) : getLegacyECItems(),
    ec_st: ui.ec_st || getPrefixedParam('ec_st') || eventData.ec_st || eventData.value,
    ec_tx: ui.ec_tx || getPrefixedParam('ec_tx') || eventData.ec_tx || eventData.tax,
    ec_sh: ui.ec_sh || getPrefixedParam('ec_sh') || eventData.ec_sh || eventData.shipping,
    ec_dt: ui.ec_dt || getPrefixedParam('ec_dt') || eventData.ec_dt || eventData.discount_amount
  };
}

function getLegacyECItems() {
  if (eventData.ec_items) {
    return eventData.ec_items;
  }

  return getType(eventData.items) === 'array'
    ? eventData.items
        .filter((item) => getType(item) === 'object')
        .map((item) => [
          item.item_id,
          item.item_name,
          item.item_category,
          item.price,
          item.quantity
        ])
    : undefined;
}

function getEcommerceProducts() {
  if (isValidValue(data.ec_products)) return normalizeProducts(data.ec_products);

  return (
    normalizeProducts(eventData[PIWIK_PARAM_PREFIX + 'ec_products']) ||
    normalizeProducts(eventData.ec_products) ||
    normalizeProducts(eventData.ec_items) ||
    normalizeProducts(eventData.items)
  );
}

function normalizeProducts(products) {
  const productsType = getType(products);
  if (productsType === 'string') return products || undefined;
  if (productsType !== 'array') return;

  const normalizedProducts = products
    .map((product) => {
      const productType = getType(product);
      if (productType === 'array') return product;
      if (productType === 'object') return convertGa4Item(product);
    })
    .filter((product) => !!product);

  return normalizedProducts.length ? normalizedProducts.slice(0, 100) : undefined;
}

// Piwik PRO product format: [sku, name, category, price, quantity, brand, variant, customDimensions]
function convertGa4Item(item) {
  const sku = isValidValue(item.item_id) ? item.item_id : item.item_name;
  if (!isValidValue(sku)) return;

  const categories = [
    item.item_category,
    item.item_category2,
    item.item_category3,
    item.item_category4,
    item.item_category5
  ]
    .filter((category) => isValidValue(category))
    .map((category) => makeString(category));

  const customDimensions = {};
  Object.keys(item).forEach((key) => {
    const index = key.slice(9);
    if (key.indexOf('dimension') === 0 && index && isValidValue(item[key])) {
      customDimensions[index] = makeString(item[key]);
    }
  });

  return [
    makeString(sku),
    isValidValue(item.item_name) ? makeString(item.item_name) : '',
    categories,
    toNumber(item.price, 0),
    toNumber(item.quantity, 1),
    isValidValue(item.item_brand) ? makeString(item.item_brand) : '',
    isValidValue(item.item_variant) ? makeString(item.item_variant) : '',
    customDimensions
  ];
}

function getPiwikParams() {
  const LIBRARY_NAME = 'sgtm_stape';
  const LIBRARY_VERSION = '1.1.0';
  const visitorId = getVisitorId();
  const isEcommerceEvent = !!ecommerceEventType;
  const isCustomEvent = !eventNameData.isPageView && !isEcommerceEvent;

  const piwikParams = {
    // Required parameters
    idsite: data.siteId,
    rec: eventData.rec || 1,
    ts_n: LIBRARY_NAME,
    ts_v: LIBRARY_VERSION,

    // Recommended parameters
    action_name:
      getPrefixedParam('action_name') ||
      (eventNameData.isPageView
        ? eventData.page_title || eventData.action_name
        : eventNameData.e_a),
    url: eventData.page_location || eventData.url,
    _id: visitorId,
    r: makeString(generateRandom(100000000, 999999999)),
    rand: eventData['x-ga-page_id'],
    apiv: eventData.apiv || 1,

    // Optional User info
    urlref: eventData.page_referrer || eventData.urlref || eventData.referrer,
    res: eventData.screen_resolution || eventData.res,
    h: eventData.h,
    m: eventData.m,
    s: eventData.s,
    cookie: eventData.cookie,
    ua: eventData.user_agent,
    uadata: eventData.uadata,
    lang: eventData.lang || eventData.language,
    uid: data.uid || eventData.uid || eventData.user_id,
    cid: visitorId,
    new_visit: eventData.new_visit,

    // Acquisition Channel Attribution
    _rcn: eventData['_rcn'] || eventData.affiliation,
    _rck: eventData['_rck'],

    // Optional Action info
    cvar: getCustomVariables(data.cvars_event) || eventData.cvar,
    _cvar: getCustomVariables(data.cvars_session) || eventData._cvar,
    link: eventData.link,
    download: eventData.download,
    search: getPrefixedParam('search') || eventData.search || eventData.search_term,
    search_cat: eventData.search_cat,
    search_cats: getSearchCategories(),
    search_count: eventData.search_count,
    pv_id: getPageViewId(),
    cur: eventData.currency || eventData.cur,
    gt_ms: eventData.gt_ms,
    cs: eventData.cs,

    // Page Performance Info
    pf_net: eventData.pf_net,
    pf_srv: eventData.pf_srv,
    pf_tfr: eventData.pf_tfr,
    pf_dm1: eventData.pf_dm1,
    pf_dm2: eventData.pf_dm2,
    pf_onl: eventData.pf_onl,

    // Event Tracking info
    e_c: isCustomEvent ? eventNameData.e_c : undefined,
    e_a: isCustomEvent ? eventNameData.e_a : undefined,
    e_n: isCustomEvent ? eventNameData.e_n : undefined,
    e_v: isCustomEvent
      ? isValidValue(getPrefixedParam('e_v'))
        ? getPrefixedParam('e_v')
        : eventData.value
      : undefined,

    // Optional Content Tracking info
    c_n: eventData.c_n,
    c_p: eventData.c_p,
    c_t: eventData.c_t,
    c_i: eventData.c_i,

    // Other parameters
    token_auth: data.tokenAuth,
    cip: data.cip || eventData.cip || eventData.ip_override,
    cdt: eventData.cdt,
    country: eventData.country,
    region: eventData.region,
    city: eventData.city,
    lat: eventData.lat,
    lon: eventData.lon || eventData.long,
    long: eventData.long,

    // Media Analytics
    ma_id: eventData.ma_id,
    ma_ti: eventData.ma_ti,
    ma_re: eventData.ma_re,
    ma_mt: eventData.ma_mt,
    ma_pn: eventData.ma_pn,
    ma_st: eventData.ma_st,
    ma_le: eventData.ma_le,
    ma_ps: eventData.ma_ps,
    ma_ttp: eventData.ma_ttp,
    ma_w: eventData.ma_w,
    ma_h: eventData.ma_h,
    ma_fs: eventData.ma_fs,
    ma_se: eventData.ma_se
  };

  // Precedence (lowest to highest): x-pp-* event data, mapped event data, tag UI fields.
  return [
    piwikParams,
    getEcommerceParams(),
    getAnonymousTrackingParams(),
    getCustomDimensions()
  ].reduce((acc, source) => {
    Object.keys(source).forEach((key) => {
      if (isValidValue(source[key])) acc[key] = source[key];
    });
    return acc;
  }, getPiwikPrefixedParams());
}

/*==============================================================================
Helpers
==============================================================================*/

function getUrl(eventData) {
  return eventData.page_location || getRequestHeader('referer') || eventData.page_referrer;
}

function shouldExitEarly(data, eventData) {
  if (!isConsentGivenOrNotRequired(data, eventData)) {
    data.gtmOnSuccess();
    return true;
  }

  const url = getUrl(eventData);
  if (url && url.lastIndexOf('https://gtm-msr.appspot.com/', 0) === 0) {
    data.gtmOnSuccess();
    return true;
  }

  if (!isValidValue(data.trackingUrl)) {
    data.gtmOnFailure();
    return true;
  }

  return false;
}

function isConsentGivenOrNotRequired(data, eventData) {
  if (data.analyticsStorageConsent !== 'required') return true;
  if (eventData.consent_state) return !!eventData.consent_state.analytics_storage;
  const xGaGcs = eventData['x-ga-gcs'] || ''; // x-ga-gcs is a string like "G110"
  return xGaGcs[3] === '1'; // The fourth character indicates analytics_storage consent
}

function isValidValue(value) {
  const valueType = getType(value);
  return valueType !== 'undefined' && valueType !== 'null' && value !== '' && value === value;
}

function hasOnlyChars(value, length, allowedChars) {
  if (value.length !== length) return false;
  return value.split('').every((char) => allowedChars.indexOf(char) !== -1);
}

function isHexString(value, length) {
  const HEX_CHARS = '0123456789abcdef';
  return hasOnlyChars(value.toLowerCase(), length, HEX_CHARS);
}

// Keeps IDs that already start with a valid hex prefix (as before 1.1.0), hashes everything else.
function normalizeVisitorId(value) {
  const stringValue = makeString(value);
  const prefix = stringValue.slice(0, 16);
  if (isHexString(prefix, 16)) return prefix;
  return sha256Sync(stringValue, { outputEncoding: 'hex' }).slice(0, 16);
}

function toNumber(value, defaultValue) {
  if (!isValidValue(value)) return defaultValue;
  const number = makeNumber(value);
  return number === number ? number : defaultValue;
}

function toParamValue(value) {
  const valueType = getType(value);
  return valueType === 'object' || valueType === 'array'
    ? JSON.stringify(value)
    : makeString(value);
}

function objectToQueryString(obj) {
  return Object.keys(obj)
    .filter((key) => isValidValue(obj[key]))
    .map((key) => encodeUriComponent(key) + '=' + encodeUriComponent(toParamValue(obj[key])))
    .join('&');
}

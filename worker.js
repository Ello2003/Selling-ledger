/**
 * Vinted item extractor — Cloudflare Worker
 * -------------------------------------------------
 * Fetches a public Vinted item page server-side (where CORS doesn't apply)
 * and returns structured JSON: title, brand, price, condition, colour,
 * description, seller, image, url.
 *
 * Deploy: see README.md in the repo root.
 * Usage:  GET https://<your-worker>.workers.dev/?url=<vinted item url>
 */

// Set this to your GitHub Pages origin once deployed, e.g.
// "https://yourusername.github.io" — or leave as "*" while testing.
const ALLOWED_ORIGIN = "*";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const reqUrl = new URL(request.url);

    // Authenticated order-history proxy: POST /orders
    if (request.method === "POST" && reqUrl.pathname.replace(/\/$/, "") === "/orders") {
      return handleOrders(request);
    }

    // Public item-page extraction: GET /?url=...
    const target = reqUrl.searchParams.get("url");
    if (!target || !/^https:\/\/(www\.)?vinted\.[a-z.]+\/items\//.test(target)) {
      return json(
        { error: "GET requests need ?url=<vinted item url>. For order history, POST /orders." },
        400
      );
    }

    try {
      const res = await fetch(target, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "Accept-Language": "en-GB,en;q=0.9",
        },
      });

      if (!res.ok) {
        return json({ error: `Vinted returned ${res.status}`, url: target }, 502);
      }

      const html = await res.text();
      const data = extractItemData(html, target);
      return json(data, 200);
    } catch (err) {
      return json({ error: String(err), url: target }, 500);
    }
  },
};

// ---------- authenticated order history ----------
//
// Mirrors the unofficial-API pattern documented by community Vinted client
// libraries: Vinted's own web app calls this same endpoint using your
// logged-in session's access token, CSRF token, and cookies. None of these
// credentials are stored by this Worker — they're forwarded from the
// request body (which the dashboard keeps only in the browser's own
// storage) straight to Vinted, per-request, and never logged.
//
// Request body:
// {
//   domain: "co.uk",            // vinted.<domain>
//   access_token, xcsrf_token,  // from your browser's Vinted session
//   cookie,                     // raw Cookie header value
//   refresh_token,              // optional, used to retry once on 401
//   type: "sold" | "purchased" | "all",
//   status: "all" | "in_progress" | "completed" | "canceled",
//   page, per_page
// }
async function handleOrders(request) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const {
    domain = "co.uk",
    access_token,
    xcsrf_token,
    cookie,
    refresh_token,
    type = "all",
    status = "all",
    page = 1,
    per_page = 50,
  } = body;

  if (!access_token || !xcsrf_token) {
    return json({ error: "access_token and xcsrf_token are required" }, 400);
  }

  const authHeaders = (token) => ({
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "x-csrf-token": xcsrf_token,
    ...(cookie ? { Cookie: cookie } : {}),
  });

  const ordersUrl = `https://www.vinted.${domain}/api/v2/my_orders?type=${encodeURIComponent(
    type
  )}&status=${encodeURIComponent(status)}&page=${page}&per_page=${per_page}`;

  try {
    let res = await fetch(ordersUrl, { headers: authHeaders(access_token) });
    let newAccessToken = null;

    // Access tokens are short-lived. If it's expired and a refresh_token
    // was supplied, refresh once and retry.
    if (res.status === 401 && refresh_token) {
      const refreshed = await refreshAccessToken(domain, refresh_token, access_token, xcsrf_token);
      if (refreshed.access_token) {
        newAccessToken = refreshed.access_token;
        res = await fetch(ordersUrl, { headers: authHeaders(newAccessToken) });
      }
    }

    if (!res.ok) {
      return json(
        { error: `Vinted returned ${res.status}. Your access_token/cookie is likely expired — copy fresh values from your browser and try again.` },
        502
      );
    }

    const data = await res.json();
    const orders = (data.my_orders || []).map((o) => ({
      orderId: o.conversation_id,
      title: o.title,
      price: o.price ? o.price.amount : "",
      currency: o.price ? o.price.currency_code : "",
      status: o.status,
      transactionStatus: o.transaction_user_status,
      date: o.date,
      image: o.photo ? o.photo.url || (o.photo.thumbnails && o.photo.thumbnails[0] && o.photo.thumbnails[0].url) : "",
      type, // "sold" | "purchased" | "all" — as requested
    }));

    return json(
      {
        orders,
        pagination: data.pagination || null,
        refreshed_access_token: newAccessToken, // save this if present — old one expired
      },
      200
    );
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

async function refreshAccessToken(domain, refresh_token, access_token, xcsrf_token) {
  try {
    const res = await fetch(`https://www.vinted.${domain}/oauth/token`, {
      method: "POST",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
        "Content-Type": "application/json",
        Authorization: `Bearer ${access_token}`,
        "x-csrf-token": xcsrf_token,
      },
      body: JSON.stringify({
        client_id: "web",
        scope: "user",
        grant_type: "refresh_token",
        refresh_token,
      }),
    });
    if (!res.ok) return {};
    const data = await res.json();
    return { access_token: data.access_token, refresh_token: data.refresh_token };
  } catch (e) {
    return {};
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ---------- extraction ----------

function extractItemData(html, url) {
  const result = {
    url,
    title: "",
    brand: "",
    price: "",
    condition: "",
    colour: "",
    description: "",
    seller: "",
    image: "",
    source: "fallback",
  };

  // 1. Try Next.js embedded page data — most reliable when present.
  const nextDataMatch = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (nextDataMatch) {
    try {
      const parsed = JSON.parse(nextDataMatch[1]);
      const item = findItemNode(parsed);
      if (item) {
        result.source = "next_data";
        result.title = item.title || result.title;
        result.brand =
          (item.brand && (item.brand.title || item.brand.name)) ||
          (item.brand_dto && item.brand_dto.title) ||
          result.brand;
        result.price =
          (item.price && (item.price.amount || item.price)) ||
          item.price_numeric ||
          result.price;
        result.condition =
          (item.status && item.status.title) ||
          item.status ||
          result.condition;
        result.colour = (item.color && item.color.title) || item.colour || result.colour;
        result.description = item.description || result.description;
        result.seller =
          (item.user && (item.user.login || item.user.username)) ||
          result.seller;
        result.image =
          (item.photos && item.photos[0] && item.photos[0].url) ||
          (item.photo && item.photo.url) ||
          result.image;
      }
    } catch (e) {
      // fall through to text-based extraction
    }
  }

  // 2. Meta tags — reliable baseline for title/description/image.
  if (!result.title) {
    result.title = metaContent(html, "og:title") || tagText(html, "title");
  }
  if (!result.description) {
    result.description = metaContent(html, "og:description");
  }
  if (!result.image) {
    result.image = metaContent(html, "og:image");
  }

  // 3. Plain-text fallback for price/brand/condition/colour/seller.
  const plain = stripTags(html);

  if (!result.price) {
    const priceMatch = plain.match(/£\s?[\d,]+\.\d{2}/);
    if (priceMatch) result.price = priceMatch[0].replace(/[£\s]/g, "");
  }
  if (!result.brand) {
    const brandMatch = plain.match(/Brand\s+([A-Za-z0-9&'.\- ]{2,40}?)(?=\s{2,}|Condition|Size|Colour)/);
    if (brandMatch) result.brand = brandMatch[1].trim();
  }
  if (!result.condition) {
    const condMatch = plain.match(/Condition\s+([A-Za-z ]{3,30}?)(?=\s{2,}|Colour|Uploaded|Material)/);
    if (condMatch) result.condition = condMatch[1].trim();
  }
  if (!result.colour) {
    const colourMatch = plain.match(/Colour\s+([A-Za-z ]{3,20}?)(?=\s{2,}|Uploaded|Material)/);
    if (colourMatch) result.colour = colourMatch[1].trim();
  }
  if (!result.seller) {
    const sellerMatch = html.match(/\/member\/\d+[^"]*"[^>]*>([^<]{2,30})</);
    if (sellerMatch) result.seller = sellerMatch[1].trim();
  }

  return result;
}

// Recursively search a parsed JSON tree for the object that looks like
// the item payload (has title + price-ish + photos/user), without
// depending on an exact known path.
function findItemNode(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 8) return null;
  if (
    typeof node.title === "string" &&
    (node.price !== undefined || node.price_numeric !== undefined) &&
    (node.photos || node.photo || node.user)
  ) {
    return node;
  }
  for (const key of Object.keys(node)) {
    const found = findItemNode(node[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function metaContent(html, property) {
  const re = new RegExp(
    `<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const altRe = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`,
    "i"
  );
  const m = html.match(re) || html.match(altRe);
  return m ? decodeEntities(m[1]) : "";
}

function tagText(html, tag) {
  const m = html.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

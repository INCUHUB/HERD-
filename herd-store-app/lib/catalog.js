/**
 * Catalogue — products, sizes and brands.
 *
 * A cafe's catalogue is a flat list of things you sell. A clothing shop's
 * is two levels: a product (a jacket) and the sizes it comes in. Almost
 * every useful stock question at HERD is asked at one level or the other —
 * "should I reorder this jacket" is a product question, "which sizes are
 * gone" is a variation question — so the index keeps both and links them.
 */

const { square } = require("./square");

const BRAND_SOURCE = process.env.BRAND_SOURCE || "category";   // category | prefix
const BRAND_SEPARATOR = process.env.BRAND_SEPARATOR || "—";

/* Size order, so a size run reads S · M · L rather than L · M · S.
   Alpha sizes first, then waist/numeric, then anything unrecognised
   in the order Square gives (which is the order set in the item). */
const ALPHA = ["XXXS","XXS","XS","S","SM","M","MD","ML","L","LG","XL","XXL","2XL","XXXL","3XL","4XL","OS","ONE SIZE"];

function sizeRank(raw) {
  const s = String(raw || "").trim().toUpperCase();
  if (!s) return [3, 0, ""];

  const alpha = ALPHA.indexOf(s.replace(/[^A-Z ]/g, ""));
  if (alpha !== -1) return [0, alpha, s];

  // "32", "W32", "32L", "UK 9", "9.5"
  const num = s.match(/(\d+(?:\.\d+)?)/);
  if (num) return [1, parseFloat(num[1]), s];

  return [2, 0, s];
}

function compareSizes(a, b) {
  const ra = sizeRank(a), rb = sizeRank(b);
  if (ra[0] !== rb[0]) return ra[0] - rb[0];
  if (ra[1] !== rb[1]) return ra[1] - rb[1];
  return ra[2].localeCompare(rb[2]);
}

function brandFrom(itemName, categoryName) {
  if (BRAND_SOURCE === "prefix") {
    const idx = itemName.indexOf(BRAND_SEPARATOR);
    if (idx > 0) return itemName.slice(0, idx).trim();
  }
  return categoryName || "Unbranded";
}

/**
 * Pull the whole catalogue once and index it.
 *
 * Returns:
 *   variations  Map  variationId -> variation record
 *   products    Map  itemId      -> product record (with its variations)
 *   categories  Map  categoryId  -> name
 */
async function catalogIndex(token) {
  const objects = [];
  let cursor;
  do {
    const page = await square(token, "/catalog/list", {
      params: { types: "ITEM,CATEGORY", cursor },
    });
    objects.push(...(page.objects || []));
    cursor = page.cursor;
  } while (cursor && objects.length < 20000);

  const categories = new Map();
  for (const o of objects) {
    if (o.type === "CATEGORY") categories.set(o.id, o.category_data?.name || "Uncategorised");
  }

  const variations = new Map();
  const products = new Map();

  for (const o of objects) {
    if (o.type !== "ITEM" || o.is_deleted) continue;
    const d = o.item_data || {};
    if (d.is_archived) continue;

    // Square has moved category_id -> categories[] over the years; the
    // reporting category is the one that drives Square's own reports, so
    // prefer it and fall back through the older shapes.
    const catId = d.reporting_category?.id || d.category_id || d.categories?.[0]?.id;
    const categoryName = categories.get(catId) || "Uncategorised";
    const itemName = d.name || "Unnamed item";
    const brand = brandFrom(itemName, categoryName);

    const product = {
      id: o.id,
      name: itemName,
      brand,
      category: categoryName,
      productType: d.product_type || "",
      createdAt: o.created_at || null,
      updatedAt: o.updated_at || null,
      imageIds: d.image_ids || [],
      variations: [],
    };

    for (const v of d.variations || []) {
      if (v.is_deleted) continue;
      const vd = v.item_variation_data || {};
      const sizeLabel = vd.name && vd.name !== "Regular" ? vd.name : "";
      const rec = {
        id: v.id,
        itemId: o.id,
        product: itemName,
        brand,
        category: categoryName,
        size: sizeLabel,
        label: sizeLabel ? `${itemName} · ${sizeLabel}` : itemName,
        sku: vd.sku || "",
        price: vd.price_money?.amount || 0,
        currency: vd.price_money?.currency || "GBP",
        // Square only reports counts for variations with tracking switched on.
        tracked: Boolean(vd.track_inventory),
        sellable: vd.sellable !== false,
        createdAt: v.created_at || o.created_at || null,
      };
      variations.set(v.id, rec);
      product.variations.push(rec);
    }

    product.variations.sort((a, b) => compareSizes(a.size, b.size));
    if (product.variations.length) products.set(o.id, product);
  }

  return { variations, products, categories, objectCount: objects.length };
}

/* Brands present in the catalogue, with how many products each carries.
   Drives the brand filter and the lead-time editor. */
function brandsFrom(products) {
  const out = new Map();
  for (const p of products.values()) {
    const cur = out.get(p.brand) || { brand: p.brand, products: 0, variations: 0 };
    cur.products += 1;
    cur.variations += p.variations.length;
    out.set(p.brand, cur);
  }
  return [...out.values()].sort((a, b) => b.variations - a.variations);
}

module.exports = { catalogIndex, brandsFrom, compareSizes, sizeRank };

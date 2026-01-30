const { S3Client, PutObjectCommand, HeadBucketCommand, GetBucketLocationCommand } = require("@aws-sdk/client-s3");

// AWS S3 configuration via environment
// Prefer AWS_* vars; fall back to S3_* for compatibility.
const AWS_REGION = process.env.AWS_REGION || process.env.S3_REGION;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY;
const BUCKET = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET;

if (!BUCKET) {
    throw new Error("Missing bucket name: set AWS_S3_BUCKET or S3_BUCKET");
}

// Helper to build S3 client (optionally with a specific region)
function createS3Client(region) {
    return new S3Client({
        region: region || AWS_REGION,
        credentials:
            AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
                ? { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY }
                : undefined,
    });
}

let s3 = createS3Client();
console.log("AWS S3 client configured", { region: AWS_REGION, bucket: BUCKET });
// Aldi API endpoint (base, without limit/offset)
const URL = "https://api.aldi.ie/v3/product-search?currency=EUR&serviceType=walk-in";

// Funzione per normalizzare prezzo da stringa a numero
function parsePrice(priceStr) {
    if (!priceStr) return null;
    return parseFloat(priceStr.replace(",", ".").replace(/[^\d.]/g, ""));
}

async function scrapeAndUpload() {
    const limit = 60;
    let offset = 0;
    let totalCount = null;
    const products = [];

    while (true) {
        const fullUrl = `${URL}&limit=${limit}&offset=${offset}&sort=name_asc&servicePoint=D105`;
        console.log("Scarico API Aldi...", fullUrl);
        const resp = await fetch(fullUrl, { headers: { accept: "application/json" } });
        if (!resp.ok) {
            throw new Error(`Richiesta fallita: HTTP ${resp.status}`);
        }
        const json = await resp.json();

        if (totalCount == null) {
            totalCount = json?.meta?.pagination?.totalCount ?? 0;
            console.log("TotalCount dichiarato:", totalCount);
        }

        const pageItems = Array.isArray(json?.data) ? json.data : [];
        const normalized = pageItems.map((item) => ({
            name: item?.name ?? null,
            price: typeof item?.price?.amountRelevant === "number" ? item.price.amountRelevant / 100 : null,
            brand: item?.brandName ?? null,
            sku: item?.sku ?? null,
            currency: item?.price?.currencyCode ?? "EUR",
            source: "aldi",
            category: Array.isArray(item?.categories)
                ? item.categories.map((c) => c?.name).filter(Boolean)
                : [],
            image: item?.assets?.find((img) => img?.mimeType && img.mimeType.startsWith("image/"))?.url ?? null,
        }));

        products.push(...normalized);
        console.log(`Pagina con offset ${offset}: +${normalized.length} (tot ${products.length})`);

        offset += limit;
        if ((totalCount && offset >= totalCount) || normalized.length === 0) break;
    }

    console.log(`Trovati ${products.length} prodotti, carico su AWS S3...`);

    // Genera chiave dinamica per ogni esecuzione
    // Use ISO timestamp to avoid spaces and locale quirks
    const now = new Date();
    const iso = now.toISOString(); // e.g. 2026-01-24T10:35:47.123Z
    const key = `${iso.substring(0, 10)}/${iso.substring(11, 19).replace(/:/g, "")}.json`; // e.g. 2026-01-24/103547.json
    console.log("Upload key:", key);

    // Ensure bucket exists and resolve its region (do not create on AWS)
    const resolvedRegion = await resolveBucketRegionSafe(BUCKET);
    if (resolvedRegion && resolvedRegion !== AWS_REGION) {
        console.log("Uso regione del bucket risolta:", resolvedRegion);
        s3 = createS3Client(resolvedRegion);
    }
    // final reachability check
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    console.log("Bucket reachable:", BUCKET);

    // Upload to AWS S3
    try {
        const putResp = await s3.send(
            new PutObjectCommand({
                Bucket: BUCKET,
                Key: key,
                Body: JSON.stringify(products, null, 2),
                ContentType: "application/json",
            })
        );
        console.log("PutObject metadata:", putResp?.$metadata);
    } catch (putErr) {
        const msg = (putErr && putErr.message) || "";
        const headers = (putErr && putErr.$metadata && putErr.$metadata.httpHeaders) || {};
        const hintedRegion = headers["x-amz-bucket-region"] || putErr.region;
        console.error("PutObject failed:", {
            name: (putErr && putErr.name) || "Unknown",
            code: (putErr && putErr.code) || "Unknown",
            message: msg,
            statusCode: putErr && putErr.$metadata && putErr.$metadata.httpStatusCode,
            hintedRegion,
        });
        throw putErr;
    }

    console.log(`Prodotti caricati su AWS S3: ${BUCKET}/${key}`);
    return { bucket: BUCKET, key, count: products.length };
}

// Simple health check against AWS S3: resolve region then head the bucket
async function s3Health() {
    try {
        const resolvedRegion = await resolveBucketRegionSafe(BUCKET);
        const client = createS3Client(resolvedRegion || AWS_REGION);
        await client.send(new HeadBucketCommand({ Bucket: BUCKET }));
        return { live: true, bucket: BUCKET, region: resolvedRegion || AWS_REGION };
    } catch (e) {
        const headers = (e && e.$metadata && e.$metadata.httpHeaders) || {};
        const hintedRegion = headers["x-amz-bucket-region"] || e.region;
        return {
            live: false,
            bucket: BUCKET,
            region: AWS_REGION,
            hintedRegion,
            error: (e && e.message) || String(e),
        };
    }
}

// Resolve bucket region via HeadBucket header or GetBucketLocation fallback
async function resolveBucketRegionSafe(bucket) {
    // First attempt: HeadBucket to read x-amz-bucket-region
    try {
        await s3.send(new HeadBucketCommand({ Bucket: bucket }));
        // If success, assume current region OK
        return AWS_REGION;
    } catch (err) {
        const headers = (err && err.$metadata && err.$metadata.httpHeaders) || {};
        let hintedRegion = headers["x-amz-bucket-region"] || err.region;
        if (!hintedRegion) {
            // Fallback: GetBucketLocation using eu-north-1 (global)
            const globalClient = createS3Client(AWS_REGION);
            try {
                const loc = await globalClient.send(new GetBucketLocationCommand({ Bucket: bucket }));
                const constraint = (loc && loc.LocationConstraint) || null;
                hintedRegion = normalizeLocation(constraint);
            } catch (locErr) {
                console.warn("GetBucketLocation fallito:", (locErr && locErr.message) || String(locErr));
            }
        }
        return hintedRegion || null;
    }
}

function normalizeLocation(constraint) {
    // Map legacy values to modern regions
    if (!constraint || constraint === "" || constraint === "US") return "us-east-1";
    if (constraint === "EU") return "eu-west-1";
    return constraint;
}

if (require.main === module) {
    scrapeAndUpload()
        .catch((e) => {
            console.error("Errore in scrapeAndUpload:", (e && e.message) || e);
        })
        .then(() => {
            console.log("Esecuzione scrapeAndUpload terminata.");
        });
}

module.exports = { scrapeAndUpload, s3Health };

const { S3Client, PutObjectCommand, HeadBucketCommand, CreateBucketCommand } = require("@aws-sdk/client-s3");

// Config MinIO/S3 from environment (with safe defaults)
const S3_ENDPOINT = process.env.S3_ENDPOINT || "https://minio-hfis.onrender.com";
const S3_REGION = process.env.S3_REGION || "us-east-1";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || "minio";
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || "miniopass";
const BUCKET = process.env.S3_BUCKET || "products";

const s3 = new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    forcePathStyle: true,
});
console.log("MinIO/S3 client configured", { endpoint: S3_ENDPOINT, region: S3_REGION, bucket: BUCKET });
// Aldi API endpoint (base, without limit/offset)
const URL = "https://api.aldi.ie/v3/product-search?currency=EUR&serviceType=walk-in";

// Funzione per normalizzare prezzo da stringa a numero
function parsePrice(priceStr) {
    if (!priceStr) return null;
    return parseFloat(priceStr.replace(",", ".").replace(/[^\d.]/g, ""));
}

async function scrapeAndUpload() {
    // Wake up Render ingestor before uploading to MinIO/S3
    const INGESTOR_URL = process.env.INGESTOR_URL || "https://ingestor-5uf2.onrender.com";
    try {
        const wake = await fetch(INGESTOR_URL, { method: "GET" });
        console.log("Ingestor wakeup status:", wake.status);
    } catch (e) {
        console.warn("Ingestor non raggiungibile (proseguo comunque):", e && e.message ? e.message : e);
    }
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

    console.log(`Trovati ${products.length} prodotti, carico su MinIO/S3...`);

    // Genera chiave dinamica per ogni esecuzione
    // Use ISO timestamp to avoid spaces and locale quirks
    const now = new Date();
    const iso = now.toISOString(); // e.g. 2026-01-24T10:35:47.123Z
    const key = `${iso.substring(0, 10)}/${iso.substring(11, 19).replace(/:/g, "")}.json`; // e.g. 2026-01-24/103547.json
    console.log("Upload key:", key);

    // Ensure bucket exists (create if missing)
    try {
        await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
        console.log("Bucket exists:", BUCKET);
    } catch (err) {
        console.warn("Bucket check failed, attempting create:", BUCKET, (err && err.name) || err);
        try {
            await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
            console.log("Bucket created:", BUCKET);
        } catch (createErr) {
            // Helpful guidance for common MinIO misconfig
            const msg = (createErr && createErr.message) || "";
            if (createErr && createErr.Code === "InvalidArgument" && msg.includes("API port")) {
                console.error("Bucket create failed: endpoint seems to be Console port. Use MinIO S3 API port (9000 or HTTPS reverse proxy). Endpoint:", S3_ENDPOINT);
            } else {
                console.error("Bucket create failed:", (createErr && createErr.name) || createErr, msg);
            }
            throw createErr;
        }
    }

    // Upload su MinIO
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
        if (putErr && putErr.Code === "InvalidArgument" && msg.includes("API port")) {
            console.error("PutObject failed: request likely sent to Console port. Set S3_ENDPOINT to MinIO S3 API port (e.g., http://host:9000 or HTTPS reverse-proxy).", { endpoint: S3_ENDPOINT });
        } else {
            console.error("PutObject failed:", (putErr && putErr.name) || putErr, msg, putErr && putErr.$metadata);
        }
        throw putErr;
    }

    console.log(`Prodotti caricati su MinIO/S3: ${BUCKET}/${key}`);
    return { bucket: BUCKET, key, count: products.length };
}

// Simple health check against MinIO API
async function s3Health() {
    const url = `${S3_ENDPOINT.replace(/\/$/, "")}/minio/health/live`;
    try {
        const resp = await fetch(url);
        return { live: resp.ok, status: resp.status, endpoint: S3_ENDPOINT };
    } catch (e) {
        return { live: false, endpoint: S3_ENDPOINT };
    }
}

module.exports = { scrapeAndUpload, s3Health };

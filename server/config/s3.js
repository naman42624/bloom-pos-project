/**
 * S3/R2 File Storage Configuration
 *
 * Supports:
 *  - AWS S3
 *  - Cloudflare R2 (S3-compatible)
 *  - MinIO (local dev)
 *
 * Replace local multer disk storage with cloud uploads.
 */

const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

let s3Client;

function getS3() {
  if (!s3Client) {
    const config = {
      region: process.env.S3_REGION || 'ap-south-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY,
      },
    };

    // Cloudflare R2 or MinIO — custom endpoint
    if (process.env.S3_ENDPOINT) {
      config.endpoint = process.env.S3_ENDPOINT;
      config.forcePathStyle = true;
    }

    s3Client = new S3Client(config);
  }
  return s3Client;
}

const BUCKET = process.env.S3_BUCKET || 'bloomcart-uploads';

/**
 * Upload a file buffer to S3
 * @param {Buffer} buffer - File data
 * @param {string} folder - e.g., 'products', 'materials', 'delivery-proofs'
 * @param {string} originalName - Original filename for extension
 * @param {string} contentType - MIME type
 * @returns {string} The S3 key (path)
 */
async function uploadFile(buffer, folder, originalName, contentType) {
  const ext = path.extname(originalName);
  const key = `${folder}/${uuidv4()}${ext}`;

  await getS3().send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000', // 1 year cache
  }));

  return key;
}

/**
 * Delete a file from S3
 */
async function deleteFile(key) {
  await getS3().send(new DeleteObjectCommand({
    Bucket: BUCKET,
    Key: key,
  }));
}

/**
 * Get a signed URL for temporary access (1 hour)
 */
async function getSignedFileUrl(key, expiresIn = 3600) {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(getS3(), command, { expiresIn });
}

/**
 * Get public URL for a file (if bucket is public or behind CDN)
 */
function getPublicUrl(key) {
  if (process.env.CDN_URL) {
    return `${process.env.CDN_URL}/${key}`;
  }
  if (process.env.S3_ENDPOINT) {
    return `${process.env.S3_ENDPOINT}/${BUCKET}/${key}`;
  }
  return `https://${BUCKET}.s3.${process.env.S3_REGION || 'ap-south-1'}.amazonaws.com/${key}`;
}

module.exports = {
  uploadFile,
  deleteFile,
  getSignedFileUrl,
  getPublicUrl,
  BUCKET,
};

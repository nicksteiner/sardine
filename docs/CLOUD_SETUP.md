# Cloud Streaming Setup for SARdine

This guide walks you through setting up AWS S3 cloud streaming for NISAR data, enabling you to stream large HDF5 files directly to your browser for GPU-accelerated rendering.

## Overview

**What you'll set up:**
- AWS S3 bucket in us-west-2 region
- CORS configuration for browser HTTP Range requests
- Data transfer from JPL's bucket to your bucket
- Pre-signed URL generation for secure access
- SARdine configuration for quick bucket access

**What you need:**
- AWS account with S3 access
- AWS CLI installed and configured
- Access to JPL's NISAR data bucket (or download capability)
- ~15-30 minutes for setup

## Part 1: AWS S3 Bucket Setup

### 1.1 Install AWS CLI (if not already installed)

```bash
# Check if AWS CLI is installed
aws --version

# If not installed, install it:
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install
```

### 1.2 Configure AWS Credentials

```bash
# Configure AWS CLI with your credentials
aws configure

# You'll be prompted for:
# - AWS Access Key ID
# - AWS Secret Access Key
# - Default region: us-west-2
# - Default output format: json
```

### 1.3 Create S3 Bucket

```bash
# Choose a unique bucket name (S3 bucket names are globally unique)
# Replace 'your-sardine-nisar' with your chosen name
BUCKET_NAME="nisar-oasis"

# Create bucket in us-west-2
aws s3 mb s3://${BUCKET_NAME} --region us-west-2

# Enable versioning (optional but recommended)
aws s3api put-bucket-versioning \
  --bucket ${BUCKET_NAME} \
  --versioning-configuration Status=Enabled
```

### 1.4 Apply CORS Configuration

This enables browser-based HTTP Range requests:

```bash
# Apply CORS configuration from cors-config.json
aws s3api put-bucket-cors \
  --bucket ${BUCKET_NAME} \
  --cors-configuration file://cors-config.json

# Verify CORS was applied
aws s3api get-bucket-cors --bucket ${BUCKET_NAME}
```

### 1.5 Choose Access Method

**Option A: Pre-signed URLs (Recommended - More Secure)**

Bucket stays private, you generate time-limited URLs:

```bash
# No additional configuration needed
# Skip to Part 2
```

**Option B: Public Bucket (Simpler - Less Secure)**

Anyone with the bucket URL can access files:

```bash
# Edit bucket-policy.json and replace 'your-sardine-nisar' with your bucket name
# Then apply:
aws s3api put-bucket-policy \
  --bucket ${BUCKET_NAME} \
  --policy file://bucket-policy.json

# Block public access settings must be disabled:
aws s3api delete-public-access-block --bucket ${BUCKET_NAME}
```

## Part 2: Data Transfer from JPL

### 2.1 Option A: Bucket-to-Bucket Copy (Fastest)

If you have direct access to JPL's S3 bucket:

```bash
# Configure JPL AWS profile (if separate from your personal AWS account)
aws configure --profile jpl

# List JPL bucket to verify access
aws s3 ls s3://jpl-nisar-bucket/L2_GCOV/ --profile jpl

# Sync entire directory
aws s3 sync \
  s3://jpl-nisar-bucket/L2_GCOV/ \
  s3://${BUCKET_NAME}/L2_GCOV/ \
  --region us-west-2 \
  --source-region us-east-1 \
  --profile jpl

# Or copy specific files
aws s3 cp \
  s3://jpl-nisar-bucket/L2_GCOV/NISAR_L2_GCOV_*.h5 \
  s3://${BUCKET_NAME}/L2_GCOV/ \
  --recursive \
  --profile jpl
```

**Cost note:** S3-to-S3 transfer across regions incurs data transfer charges (~$0.02/GB).

### 2.2 Option B: Download + Upload via Local Machine

If you have NISAR files locally:

```bash
# Upload from local directory
aws s3 sync \
  ./local/nisar/data/ \
  s3://${BUCKET_NAME}/L2_GCOV/ \
  --region us-west-2

# Or single file
aws s3 cp \
  ./NISAR_L2_GCOV_001_001_A_001.h5 \
  s3://${BUCKET_NAME}/L2_GCOV/
```

### 2.3 Option C: rclone for NASA Earthdata

If you need to download from NASA Earthdata and upload to S3:

```bash
# Install rclone
curl https://rclone.org/install.sh | sudo bash

# Configure rclone for Earthdata (requires NASA Earthdata account)
rclone config
# Select: n) New remote
# Name: earthdata
# Type: 50 (WebDAV)
# URL: https://asf.alaska.edu/
# Username: (your Earthdata username)
# Password: (your Earthdata password)

# Configure rclone for S3
rclone config
# Select: n) New remote
# Name: s3west
# Type: 5 (Amazon S3)
# Provider: 1 (AWS)
# Region: us-west-2
# (Use AWS credentials from environment or enter manually)

# Copy files
rclone copy earthdata:/NISAR/L2_GCOV/ s3west:${BUCKET_NAME}/L2_GCOV/ \
  --progress \
  --transfers 8 \
  --checkers 16
```

### 2.4 Verify Transfer

```bash
# Check file count and total size
aws s3 ls s3://${BUCKET_NAME}/L2_GCOV/ \
  --recursive \
  --human-readable \
  --summarize

# List specific files
aws s3 ls s3://${BUCKET_NAME}/L2_GCOV/ | grep "\.h5$"
```

## Part 3: Generate Pre-signed URLs

### 3.1 Configure the Script

Edit `generate-signed-url.sh` and update these lines:

```bash
BUCKET="your-actual-bucket-name"  # Replace with your bucket name
REGION="us-west-2"
```

### 3.2 Generate URL for a Single File

```bash
# Generate 1-hour URL (default)
./generate-signed-url.sh L2_GCOV/NISAR_L2_GCOV_001_001_A_001_4000_SHNA_A_20250101T000000_20250101T000030_P00001_F001_J001_001.h5

# Generate 24-hour URL
./generate-signed-url.sh L2_GCOV/NISAR_L2_GCOV_001_001_A_001.h5 86400

# Generate 7-day URL (maximum)
./generate-signed-url.sh L2_GCOV/NISAR_L2_GCOV_001_001_A_001.h5 604800
```

The script will output a long URL like:
```
https://your-sardine-nisar.s3.us-west-2.amazonaws.com/L2_GCOV/NISAR_..._001.h5?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=...&X-Amz-Signature=...
```

Copy this URL to use in SARdine.

### 3.3 Batch Generate URLs

For multiple files:

```bash
# Create batch script
cat > generate-all-urls.sh << 'EOF'
#!/bin/bash
BUCKET="your-sardine-nisar"
EXPIRATION=86400  # 24 hours

aws s3 ls s3://${BUCKET}/L2_GCOV/ --recursive | \
  grep '\.h5$' | \
  awk '{print $4}' | \
  while read key; do
    echo "=== $key ==="
    ./generate-signed-url.sh "$key" "$EXPIRATION"
    echo ""
  done
EOF

chmod +x generate-all-urls.sh
./generate-all-urls.sh > signed-urls.txt
```

## Part 4: Configure SARdine for Your Bucket

### 4.1 Update Bucket Preset

Edit [src/utils/bucket-browser.js](src/utils/bucket-browser.js):

```javascript
{
  label: 'Personal NISAR (us-west)',
  url: 'https://YOUR-ACTUAL-BUCKET-NAME.s3.us-west-2.amazonaws.com',
  description: 'Personal S3 bucket in us-west-2',
},
```

Replace `YOUR-ACTUAL-BUCKET-NAME` with your bucket name.

### 4.2 Rebuild SARdine (if running from source)

```bash
# If you're running from source
npm run build

# Or just run dev server (changes auto-reload)
npm run dev
```

## Part 5: Using SARdine with Cloud Data

### 5.1 Method 1: Direct URL Input (COG URL field)

1. Open SARdine in your browser
2. Select **COG** file type
3. Paste your signed URL or public bucket URL into the URL field
4. Click **Load**

**For public buckets:**
```
https://your-sardine-nisar.s3.us-west-2.amazonaws.com/L2_GCOV/NISAR_..._001.h5
```

**For pre-signed URLs:**
```
https://your-sardine-nisar.s3.us-west-2.amazonaws.com/L2_GCOV/NISAR_..._001.h5?X-Amz-Algorithm=AWS4-HMAC-SHA256&...
```

### 5.2 Method 2: DataDiscovery Browser (Public Buckets Only)

1. Open SARdine
2. Click **Remote** tab
3. Select **"Personal NISAR (us-west)"** from presets (or enter bucket URL manually)
4. Click **Connect**
5. Browse directories
6. Click on any `.h5` file to load it

**Note:** DataDiscovery uses S3 ListObjectsV2 API, which requires either:
- Public ListBucket permission, OR
- Signed bucket URL with list permissions (advanced)

For private buckets, use Method 1 with pre-signed URLs.

### 5.3 Verify Streaming is Working

Open browser DevTools (F12) → Network tab:
- You should see multiple **Range requests** (206 Partial Content responses)
- Each request fetches ~50-500 KB chunks
- Total data transferred should be much less than full file size

**Example:**
- Full file: 4.2 GB
- Viewport data: ~8 MB (0.2% of file)
- Load time: 2-3 seconds

## Part 6: Testing & Validation

### 6.1 Test Single-Band Loading

1. Load a single-polarization file (e.g., HHHH)
2. Verify GPU rendering (smooth pan/zoom at 60fps)
3. Check browser Activity Monitor for GPU usage
4. Try different colormaps and stretch modes

### 6.2 Test RGB Composites

1. Load a file with multiple polarizations
2. Enable **RGB Composite** mode
3. Select preset: **"Dual-pol H"** or **"Pauli"**
4. Adjust per-channel contrast sliders
5. Verify colors update in real-time

### 6.3 Test Export Functionality

1. **Raw Export:** File → Export → Raw Float32 GeoTIFF
   - Verify file opens in QGIS with correct georeference
2. **Rendered Export:** File → Export → Rendered RGBA GeoTIFF
   - Verify colormap and stretch are applied
3. **RGB Export:** (in RGB mode) File → Export → RGB Composite
   - Verify all 3 channels are present
4. **Figure Export:** File → Export → Figure PNG
   - Verify scale bar, coordinates, and colorbar are overlaid

### 6.4 Performance Benchmarks

Expected performance metrics:

| Metric | Target | Your Result |
|--------|--------|-------------|
| Initial metadata load | <2s | _____ |
| First viewport render | <3s | _____ |
| Pan/zoom framerate | 60fps | _____ |
| Switch polarization | <1s | _____ |
| RGB composite switch | <2s | _____ |

## Troubleshooting

### CORS Errors

**Symptom:** Console shows "CORS policy: No 'Access-Control-Allow-Origin' header"

**Fix:**
```bash
# Re-apply CORS configuration
aws s3api put-bucket-cors \
  --bucket ${BUCKET_NAME} \
  --cors-configuration file://cors-config.json

# Verify it was applied
aws s3api get-bucket-cors --bucket ${BUCKET_NAME}
```

### 403 Forbidden Errors

**Symptom:** Loading fails with 403 status

**Possible causes:**
1. **Private bucket without signed URL** → Generate signed URL
2. **Expired signed URL** → Generate new URL (check expiration time)
3. **Bucket policy missing** → Apply public read policy (or use signed URLs)
4. **Wrong region** → Verify bucket is in us-west-2

**Fix:**
```bash
# Check bucket policy
aws s3api get-bucket-policy --bucket ${BUCKET_NAME}

# Check public access block
aws s3api get-public-access-block --bucket ${BUCKET_NAME}
```

### Slow Loading / Timeouts

**Symptom:** Loading takes >10 seconds or times out

**Possible causes:**
1. **Large metadata page** → h5chunk should use lazy tree-walking (check console logs)
2. **Network latency** → Test from location closer to us-west-2
3. **Throttling** → Check AWS CloudWatch for throttling metrics

**Fix:**
```bash
# Check CloudWatch metrics for bucket
aws cloudwatch get-metric-statistics \
  --namespace AWS/S3 \
  --metric-name NumberOf Objects \
  --dimensions Name=BucketName,Value=${BUCKET_NAME} \
  --start-time 2025-01-01T00:00:00Z \
  --end-time 2025-12-31T23:59:59Z \
  --period 86400 \
  --statistics Average
```

### RGB Composites Not Working

**Symptom:** RGB mode shows black screen or wrong colors

**Possible causes:**
1. **Missing polarizations** → Verify file contains required pols (HHHH, HVHV, VVVV)
2. **Contrast limits wrong** → Reset to auto-contrast
3. **GPU memory issues** → Check GPU has >2GB VRAM available

**Fix:**
- Check browser console for errors
- Try single-band mode first
- Reduce viewport size (zoom in)

## Cost Estimates

### Storage Costs (us-west-2)
- **S3 Standard:** $0.023/GB/month
- **Example:** 100 GB NISAR data = ~$2.30/month

### Data Transfer Costs
- **Transfer IN to S3:** Free
- **Transfer OUT to Internet:** $0.09/GB (after 100 GB free tier)
- **Example:** 10 GB exploration/month = ~$0.90/month

### Request Costs
- **GET requests:** $0.0004 per 1,000 requests
- **Example:** 1,000 chunk fetches = ~$0.0004

**Total estimated cost:** ~$3-5/month for moderate use

## Next Steps

### Optimization Ideas

1. **CloudFront CDN:** Add CloudFront distribution for faster global access
2. **S3 Intelligent-Tiering:** Auto-move infrequently accessed files to cheaper storage
3. **Lambda@Edge:** Generate signed URLs on-demand without scripts
4. **Batch Processing:** Set up Nextflow pipeline triggered by S3 uploads

### Automation Scripts

```bash
# Auto-sync from JPL daily (cron job)
0 2 * * * aws s3 sync s3://jpl-nisar-bucket/L2_GCOV/ s3://${BUCKET_NAME}/L2_GCOV/ --profile jpl

# Auto-expire old signed URLs and generate new ones
# (TODO: create Lambda function)
```

## Additional Resources

- [AWS S3 Documentation](https://docs.aws.amazon.com/s3/)
- [AWS CLI S3 Commands](https://docs.aws.amazon.com/cli/latest/reference/s3/)
- [CORS Configuration Reference](https://docs.aws.amazon.com/AmazonS3/latest/userguide/cors.html)
- [Pre-signed URLs Guide](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ShareObjectPreSignedURL.html)
- [SARdine Documentation](https://github.com/nasa/sardine)

## Support

For issues specific to:
- **AWS/S3 setup:** Check AWS documentation or AWS Support
- **SARdine cloud streaming:** Open issue at https://github.com/nasa/sardine/issues
- **NISAR data access:** Contact ASF DAAC or JPL data support

# IAM Permission Request for NISAR S3 Bucket

**Requested by:** nsteiner
**IAM User ARN:** arn:aws:iam::616037131098:user/nsteiner
**Date:** 2025-02-11
**Purpose:** Enable S3 operations on `nisar-oasis` bucket for NISAR SAR data analysis

---

## Summary

I need permissions to manage and access the `nisar-oasis` S3 bucket in us-west-2 for storing and streaming NISAR satellite data. This bucket will be used with the SARdine browser-based analysis tool.

## Required Permissions

Please create and attach the following IAM policy to my user account:

**Policy Name:** `NISAROasisBucketAccess`

**Policy Document:** (see `iam-policy-nisar-oasis.json`)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "NISAROasisBucketManagement",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:GetBucketVersioning",
        "s3:PutBucketVersioning",
        "s3:GetBucketCORS",
        "s3:PutBucketCORS",
        "s3:GetBucketPolicy",
        "s3:PutBucketPolicy",
        "s3:DeleteBucketPolicy",
        "s3:GetBucketPublicAccessBlock",
        "s3:PutBucketPublicAccessBlock"
      ],
      "Resource": [
        "arn:aws:s3:::nisar-oasis"
      ]
    },
    {
      "Sid": "NISAROasisObjectOperations",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:ListMultipartUploadParts",
        "s3:AbortMultipartUpload"
      ],
      "Resource": [
        "arn:aws:s3:::nisar-oasis/*"
      ]
    },
    {
      "Sid": "ListAllBuckets",
      "Effect": "Allow",
      "Action": [
        "s3:ListAllMyBuckets",
        "s3:GetBucketLocation"
      ],
      "Resource": "*"
    }
  ]
}
```

## Commands to Apply (for AWS Admin)

### Option 1: Using AWS CLI

```bash
# 1. Create the policy
aws iam create-policy \
  --policy-name NISAROasisBucketAccess \
  --policy-document file://iam-policy-nisar-oasis.json \
  --description "Permissions for nisar-oasis S3 bucket operations"

# 2. Attach to user nsteiner
aws iam attach-user-policy \
  --user-name nsteiner \
  --policy-arn arn:aws:iam::616037131098:policy/NISAROasisBucketAccess
```

### Option 2: Using AWS Console

1. Go to IAM Console: https://console.aws.amazon.com/iam/
2. Click **Policies** → **Create policy**
3. Click **JSON** tab
4. Paste the policy document above
5. Click **Next** → Name: `NISAROasisBucketAccess`
6. Click **Create policy**
7. Go to **Users** → **nsteiner** → **Permissions** tab
8. Click **Add permissions** → **Attach policies directly**
9. Search for `NISAROasisBucketAccess` → Select it
10. Click **Add permissions**

## Alternative: Attach Managed Policy (Less Granular)

If creating a custom policy is not preferred, you can attach the AWS managed policy:

```bash
aws iam attach-user-policy \
  --user-name nsteiner \
  --policy-arn arn:aws:iam::aws:policy/AmazonS3FullAccess
```

**Note:** This grants access to ALL S3 buckets, not just `nisar-oasis`. The custom policy above is more secure as it's scoped to only the specific bucket.

## Use Case Details

### What I need to do:

1. **Upload NISAR data files** (4-8 GB HDF5 files) from JPL to the bucket
2. **Configure CORS** to enable browser-based HTTP Range requests for streaming
3. **Set bucket policies** for either public read access or pre-signed URL generation
4. **Manage bucket versioning** (optional, for data safety)
5. **Stream data to browser** using SARdine for GPU-accelerated SAR visualization

### Security Notes:

- The policy is scoped to ONLY the `nisar-oasis` bucket (least privilege)
- No permissions for other AWS services (EC2, Lambda, etc.)
- No permissions to modify IAM policies or other buckets
- Can be revoked at any time

### Data Volume:

- Expected storage: 100-500 GB NISAR Level-2 products
- Transfer frequency: Monthly syncs from JPL data sources
- Access pattern: Streaming via HTTP Range requests (minimal data transfer)

## Verification After Permission Grant

Once permissions are applied, I'll verify with:

```bash
# Test basic access
aws s3 ls s3://nisar-oasis/

# Apply CORS configuration
aws s3api put-bucket-cors \
  --bucket nisar-oasis \
  --cors-configuration file://cors-config.json

# Test upload
echo "test" > test.txt
aws s3 cp test.txt s3://nisar-oasis/test.txt
rm test.txt
```

## Questions?

Contact: nsteiner
Project: SARdine - Browser-based SAR Data Analysis
Repository: https://github.com/nasa/sardine (if applicable)

---

**Thank you for your support!**

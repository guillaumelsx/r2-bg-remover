import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "stream";

const r2 = new S3Client({
  region: "auto",
  endpoint: "https://cd3f38fcaf8dca226a6c08ebc2616089.r2.cloudflarestorage.com",
  credentials: {
    accessKeyId: process.env.ACCESS_KEY_ID!,
    secretAccessKey: process.env.SECRET_ACCESS_KEY!,
  },
});

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function removeBg(imageBuffer: Buffer, filename: string, maxRetries = 5): Promise<ArrayBuffer> {
  const apiKey = process.env.REMOVE_BG_API_KEY;
  if (!apiKey) {
    throw new Error("REMOVE_BG_API_KEY environment variable is not set");
  }

  for (let retries = 0; retries < maxRetries; retries++) {
    // Recreate FormData for each attempt (can't reuse FormData after sending)
    const formData = new FormData();
    formData.append("size", "auto");
    
    // Create a File from the buffer and append as file
    // Convert Buffer to Uint8Array for File compatibility
    const file = new File([new Uint8Array(imageBuffer)], filename, {
      type: "image/png", // Will work for any image type
    });
    formData.append("image_file", file);

    const response = await fetch("https://api.remove.bg/v1.0/removebg", {
      method: "POST",
      headers: { "X-Api-Key": apiKey },
      body: formData,
    });

    if (response.ok) {
      return await response.arrayBuffer();
    } else if (response.status === 429) {
      // Rate limit exceeded - use exponential backoff with randomization
      // Following remove.bg official documentation: waitTime = 2^retries + random (in seconds)
      // https://www.remove.bg/api#rate-limit
      const waitTime = Math.pow(2, retries) + Math.random(); // Add jitter to prevent thundering herd
      const waitTimeSeconds = Math.round(waitTime * 10) / 10; // Round to 1 decimal place
      console.log(`  Rate limit hit, waiting ${waitTimeSeconds}s before retry ${retries + 1}/${maxRetries}...`);
      await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
      continue;
    } else {
      const errorText = await response.text();
      throw new Error(`${response.status}: ${response.statusText} - ${errorText}`);
    }
  }
  
  throw new Error(`Failed after ${maxRetries} retries due to rate limiting`);
}

async function processImage(key: string, bucket: string, folderPrefix: string): Promise<void> {
  // remove.bg always returns PNG format, so convert all files to .png extension
  let finalKey = key;
  const lowerKey = key.toLowerCase();
  if (lowerKey.endsWith('.jpeg') || lowerKey.endsWith('.jpg') || lowerKey.endsWith('.webp')) {
    finalKey = key.replace(/\.(jpeg|jpg|webp)$/i, '.png');
  }
  
  // Check if file already exists (allows resuming)
  const outputDir = path.join(process.cwd(), 'processed-images');
  const relativePath = finalKey.replace(folderPrefix, '');
  const filePath = path.join(outputDir, relativePath);
  
  if (fs.existsSync(filePath)) {
    console.log(`⏭ Skipping ${key} (already processed)`);
    return;
  }
  
  try {
    console.log(`Processing: ${key}`);
    
    // Download image from R2
    const getCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    const getResponse = await r2.send(getCommand);
    
    if (!getResponse.Body) {
      throw new Error(`Failed to download ${key} from R2`);
    }
    
    // Convert stream to buffer
    const imageBuffer = await streamToBuffer(getResponse.Body as Readable);
    
    // Remove background using remove.bg API (with retry logic)
    const processedImageBuffer = await removeBg(imageBuffer, key);
    
    if (lowerKey.endsWith('.jpeg') || lowerKey.endsWith('.jpg') || lowerKey.endsWith('.webp')) {
      console.log(`  Converting ${key} → ${finalKey}`);
    }
    
    // Save processed image locally
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Create subdirectories if needed (preserve folder structure)
    const fileDir = path.dirname(filePath);
    
    if (!fs.existsSync(fileDir)) {
      fs.mkdirSync(fileDir, { recursive: true });
    }
    
    fs.writeFileSync(filePath, Buffer.from(processedImageBuffer));
    console.log(`✓ Successfully saved: ${filePath}`);
  } catch (error) {
    console.error(`✗ Error processing ${key}:`, error instanceof Error ? error.message : error);
    throw error;
  }
}

async function run() {
  const bucket = "harmony";
  const folderPrefix = "recommendation/eat/";

  // List all images in the folder
  const command = new ListObjectsV2Command({ 
    Bucket: bucket,
    Prefix: folderPrefix
  });
  const response = await r2.send(command);

  const objects = response.Contents ?? [];
  const imageKeys = objects
    .map((obj) => obj.Key)
    .filter((key): key is string => 
      key !== undefined && 
      (key.toLowerCase().endsWith('.png') || 
       key.toLowerCase().endsWith('.webp') || 
       key.toLowerCase().endsWith('.jpeg') || 
       key.toLowerCase().endsWith('.jpg'))
    )
    .reverse(); // Process from bottom of list

  console.log(`Found ${imageKeys.length} images to process (starting from bottom)\n`);

  // Process images sequentially with a small delay to avoid rate limiting
  for (let i = 0; i < imageKeys.length; i++) {
    const key = imageKeys[i];
    
    try {
      await processImage(key, bucket, folderPrefix);
      
      // Add delay between requests to avoid rate limiting (except for last item)
      // Increased delay to 3 seconds to respect API limits better
      if (i < imageKeys.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 3000)); // 3 second delay
      }
    } catch (error) {
      console.error(`Failed to process ${key}, continuing with next image...`);
      // Continue with next image even if one fails
    }
  }

  console.log(`\n✓ Finished processing ${imageKeys.length} images`);
}

run().catch(console.error);

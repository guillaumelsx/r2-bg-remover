# r2-bg-remover

Batch process images stored in Cloudflare R2 by removing their backgrounds using the [remove.bg](https://www.remove.bg/) API.

## Features

- Lists and processes images from a Cloudflare R2 bucket
- Removes backgrounds using the remove.bg API
- Handles rate limiting with exponential backoff
- Supports resuming (skips already-processed images)
- Converts JPEG/WebP to PNG (remove.bg output format)

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file with your credentials:
   ```
   ACCESS_KEY_ID=your_r2_access_key
   SECRET_ACCESS_KEY=your_r2_secret_key
   REMOVE_BG_API_KEY=your_removebg_api_key
   ```

3. Update the R2 endpoint and bucket/prefix in `r2-list.ts` if needed.

## Usage

```bash
npm start
```

Processed images are saved to `processed-images/` with the original folder structure preserved.

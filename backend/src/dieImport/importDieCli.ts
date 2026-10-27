import path from "node:path";
import { config } from "../config.js";
import { ensureDataStore } from "../store.js";
import { importDieShot } from "./importer.js";

// Imports a die shot straight from disk: no upload, the original stored as a
// tiled TIFF and the whole tile pyramid built up front. Suited to gigapixel
// JPEGs, where lazy tiles and crops would each re-decode the file.
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.image) {
    printUsage();
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  const filePath = path.resolve(options.image);
  const mimeType = mimeTypeForPath(filePath);
  await ensureDataStore(config.dataRoot);
  const started = Date.now();
  const record = await importDieShot({
    dataRoot: config.dataRoot,
    filePath,
    originalFilename: path.basename(filePath),
    mimeType,
    tileSize: config.tileSize,
    limitInputPixels: config.limitInputPixels,
    tileConcurrency: config.tileConcurrency,
    name: options.name,
    tiledOriginal: !options.keepOriginal,
    prebuildTiles: !options.lazyTiles,
    onProgress: (update) => console.log(`[${update.phase}] ${update.message}`),
    logger: (message) => console.log(message)
  });

  console.log(
    `\nImported ${record.name} (${record.width}x${record.height}, ${record.levels.length} levels) as die ${record.id} in ${((Date.now() - started) / 1000).toFixed(0)}s.`
  );
}

function parseArgs(args: string[]) {
  const options: {
    image?: string;
    name?: string;
    keepOriginal: boolean;
    lazyTiles: boolean;
    help: boolean;
  } = {
    keepOriginal: false,
    lazyTiles: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--name") {
      options.name = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--keep-original") {
      options.keepOriginal = true;
      continue;
    }
    if (arg === "--lazy-tiles") {
      options.lazyTiles = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (!arg.startsWith("--") && !options.image) {
      options.image = arg;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function mimeTypeForPath(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  throw new Error(`Unsupported image type: ${extension || "<none>"} (PNG or JPEG only)`);
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  npm run import-die -w backend -- <image.jpg|image.png> [--name <name>] [--keep-original] [--lazy-tiles]",
      "",
      "  --keep-original  store the file as-is instead of converting it to a tiled TIFF",
      "  --lazy-tiles     skip building the tile pyramid; tiles are generated on first view",
      "",
      "Example:",
      "  npm run import-die -w backend -- ~/Downloads/die.jpg --name my-chip"
    ].join("\n")
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

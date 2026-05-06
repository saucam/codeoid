/**
 * Shareable-session subsystem — public API.
 *
 * Bundle format + path rewriting + git-alias resolution + pack/unpack
 * helpers, all surfaced via this barrel so session-manager only has
 * one import.
 */

export {
  SHARE_FORMAT_VERSION,
  MIN_SHARE_FORMAT_VERSION,
  type ShareBundle,
  type ShareManifest,
  type ShareIdentity,
  type ShareSessionMeta,
  type ShareWorkdirInfo,
  type ShareEpisode,
  type ShareFileSnapshot,
  isShareBundle,
  checkBundleVersion,
} from "./manifest.js";

export {
  resolveWorkdirAlias,
  remoteToAlias,
  type AliasResolution,
} from "./git-alias.js";

export {
  encodePath,
  decodePath,
  encodePathArray,
  decodePathArray,
  rewriteTextPaths,
  restoreTextPaths,
  EXTERNAL_PREFIX,
} from "./path-rewrite.js";

export {
  packSession,
  writeBundleToFile,
  type PackInput,
  type PackDependencies,
} from "./pack.js";

export {
  validateBundle,
  unpackBundle,
  type UnpackInput,
  type UnpackDependencies,
  type UnpackResult,
  type ImportedSessionInit,
} from "./unpack.js";

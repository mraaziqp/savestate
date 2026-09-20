import { pgTable, text, varchar, timestamp, integer, bigint, boolean, jsonb } from 'drizzle-orm/pg-core';

/**
 * Google Drive Endpoints Schema
 * Supports multi-drive routing (e.g. gdrive_primary for vaults, gdrive_media for movies/TV)
 */
export const gdriveEndpoints = pgTable('gdrive_endpoints', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: text('name').notNull(),
  endpointType: varchar('endpoint_type', { length: 32 }).default('primary').notNull(), // 'primary' | 'media'
  remoteFs: text('remote_fs').notNull(), // e.g. 'gdrive:NexusArchive/primary'
  isDefault: boolean('is_default').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type GDriveEndpoint = typeof gdriveEndpoints.$inferSelect;
export type NewGDriveEndpoint = typeof gdriveEndpoints.$inferInsert;

/**
 * Google Drive Resumable Upload Tracking Schema
 * Enforces strict 256 KiB (262,144 bytes) chunk boundaries and stores session URIs
 * for zero-loss resumption and instant hash deduplication.
 */
export const gdriveResumableUploads = pgTable('gdrive_resumable_uploads', {
  id: varchar('id', { length: 64 }).primaryKey(),
  userId: text('user_id'),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').default('application/octet-stream').notNull(),
  fileSize: bigint('file_size', { mode: 'number' }).notNull(),
  fileHash: varchar('file_hash', { length: 128 }).notNull(),
  driveTarget: varchar('drive_target', { length: 64 }).default('gdrive_primary').notNull(),
  sessionUri: text('session_uri').notNull(),
  chunkOffset: bigint('chunk_offset', { mode: 'number' }).default(0).notNull(),
  chunkSize: integer('chunk_size').default(262144).notNull(), // 256 KiB standard
  status: varchar('status', { length: 32 }).default('initiated').notNull(), // 'initiated' | 'uploading' | 'synced' | 'failed'
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type GDriveResumableUpload = typeof gdriveResumableUploads.$inferSelect;
export type NewGDriveResumableUpload = typeof gdriveResumableUploads.$inferInsert;

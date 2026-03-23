<?php
// Migrate orphaned documents from SQLite docs.db to PostgreSQL
require_once '/var/www/mail/api/db.php';

$pg = getPGDB();

// Check which doc_ids already exist in PG
$check = $pg->query("SELECT doc_id FROM docs_documents");
$existing = [];
while ($row = $check->fetch()) { $existing[] = $row['doc_id']; }

// Read from SQLite
$sqlite = new PDO('sqlite:/var/www/mail/data/docs.db');
$sqlite->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$rows = $sqlite->query("SELECT * FROM documents ORDER BY id ASC")->fetchAll(PDO::FETCH_ASSOC);

$migrated = 0;
foreach ($rows as $row) {
    if (in_array($row['doc_id'], $existing)) {
        echo "SKIP (exists): " . $row['doc_id'] . " - " . $row['title'] . "\n";
        continue;
    }
    $stmt = $pg->prepare("INSERT INTO docs_documents (doc_id, title, type, owner_email, owner_name, content, thumbnail, is_trashed, is_starred, folder_id, last_edited_by, version, created_at, updated_at, file_size, drive_file_id, original_filename) VALUES (:doc_id, :title, :type, :owner_email, :owner_name, :content, :thumbnail, :is_trashed, :is_starred, :folder_id, :last_edited_by, :version, :created_at, :updated_at, :file_size, :drive_file_id, :original_filename)");
    $stmt->execute([
        ':doc_id' => $row['doc_id'],
        ':title' => $row['title'],
        ':type' => $row['type'],
        ':owner_email' => $row['owner_email'],
        ':owner_name' => $row['owner_name'] ?: '',
        ':content' => $row['content'] ?: '',
        ':thumbnail' => $row['thumbnail'] ?: '',
        ':is_trashed' => (int)$row['is_trashed'],
        ':is_starred' => (int)$row['is_starred'],
        ':folder_id' => $row['folder_id'] ?: null,
        ':last_edited_by' => $row['last_edited_by'] ?: '',
        ':version' => (int)$row['version'],
        ':created_at' => $row['created_at'],
        ':updated_at' => $row['updated_at'],
        ':file_size' => (int)($row['file_size'] ?? 0),
        ':drive_file_id' => $row['drive_file_id'] ?: null,
        ':original_filename' => $row['original_filename'] ?: '',
    ]);
    $migrated++;
    echo "MIGRATED: " . $row['doc_id'] . " - " . $row['title'] . "\n";
}
echo "\nTotal migrated: $migrated\n";

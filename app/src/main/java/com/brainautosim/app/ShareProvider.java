package com.brainautosim.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * Minimal read-only provider that hands a results file from the app's cache to the app the
 * user picks in the share sheet (Gmail, Drive, WhatsApp...). Nothing else is reachable.
 */
public class ShareProvider extends ContentProvider {
    static final String DIR = "share";

    static Uri uriFor(Context c, File f) {
        return new Uri.Builder().scheme("content").authority(c.getPackageName() + ".share").appendPath(f.getName()).build();
    }

    private File fileFor(Uri uri) {
        Context c = getContext();
        String name = uri.getLastPathSegment();
        if (c == null || name == null || name.contains("/") || name.contains("..")) return null;
        return new File(new File(c.getCacheDir(), DIR), name);
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        File f = fileFor(uri);
        if (f == null || !f.isFile()) throw new FileNotFoundException(String.valueOf(uri));
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        File f = fileFor(uri);
        if (f == null || !f.isFile()) return null;
        String[] cols = projection != null ? projection : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = f.getName();
            else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
        }
        MatrixCursor cursor = new MatrixCursor(cols, 1);
        cursor.addRow(row);
        return cursor;
    }

    @Override
    public String getType(Uri uri) {
        String name = String.valueOf(uri.getLastPathSegment()).toLowerCase(java.util.Locale.ROOT);
        if (name.endsWith(".csv")) return "text/csv";
        if (name.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("read-only");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}

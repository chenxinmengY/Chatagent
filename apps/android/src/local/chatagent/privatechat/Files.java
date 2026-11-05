package local.chatagent.privatechat;

import android.content.*;
import android.database.*;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.*;
import java.security.MessageDigest;
import org.json.JSONObject;

public final class Files extends ContentProvider {
  static String hash(File file) throws Exception { MessageDigest digest = MessageDigest.getInstance("SHA-256"); try (InputStream input = new FileInputStream(file)) { byte[] buffer = new byte[65536]; int count; while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count); } StringBuilder text = new StringBuilder(); for (byte value : digest.digest()) text.append(String.format("%02x", value & 255)); return text.toString(); }
  static boolean valid(File file, JSONObject metadata) throws Exception { return file.isFile() && file.length() == metadata.getLong("bytes") && hash(file).equals(metadata.getString("sha256")); }
  private File file(Uri uri) throws FileNotFoundException { String name = uri.getLastPathSegment(); if (name == null || !name.matches("[a-f0-9]{64}")) throw new FileNotFoundException(); return new File(getContext().getFilesDir(), "media/" + name); }
  public boolean onCreate() { return true; }
  public String getType(Uri uri) { return "application/octet-stream"; }
  public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException { if (!mode.equals("r")) throw new FileNotFoundException(); return ParcelFileDescriptor.open(file(uri), ParcelFileDescriptor.MODE_READ_ONLY); }
  public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) { MatrixCursor result = new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}); try { File file = file(uri); result.addRow(new Object[]{uri.getQueryParameter("name"), file.length()}); } catch (Exception ignored) { } return result; }
  public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
  public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
  public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
}

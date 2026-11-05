package local.chatagent.privatechat;

import android.content.*;
import android.database.Cursor;
import android.database.sqlite.*;
import org.json.*;
import java.util.*;

final class LocalStore extends SQLiteOpenHelper {
  private static final Map<String,LocalStore> instances=new HashMap<>();
  private final Context appContext;
  final String chatId;
  static String selected(Context context){return context.getSharedPreferences("chat-selection",0).getString("id","default");}
  static synchronized LocalStore get(Context context) {return get(context,selected(context));}
  static synchronized LocalStore get(Context context,String id){if(!id.equals("default")&&!id.matches("[a-f0-9-]{36}"))throw new IllegalArgumentException("INVALID_CHAT");if(!instances.containsKey(id))instances.put(id,new LocalStore(context.getApplicationContext(),id));return instances.get(id);}
  private LocalStore(Context context,String id) { super(context,id.equals("default")?"chatagent.sqlite":"chatagent-"+id+".sqlite", null, 1);appContext=context;chatId=id;setWriteAheadLoggingEnabled(true); }
  List<LocalStore> siblings(){List<LocalStore> result=new ArrayList<>();result.add(get(appContext,"default"));for(String file:appContext.databaseList())if(file.matches("chatagent-[a-f0-9-]{36}\\.sqlite"))result.add(get(appContext,file.substring(10,file.length()-7)));return result;}
  public void onCreate(SQLiteDatabase db) { db.execSQL("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)"); db.execSQL("CREATE TABLE messages(id TEXT PRIMARY KEY,seq INTEGER NOT NULL,created INTEGER NOT NULL,body TEXT NOT NULL)"); db.execSQL("CREATE TABLE outbox(id TEXT PRIMARY KEY,body TEXT NOT NULL)"); }
  public void onUpgrade(SQLiteDatabase db, int old, int next) { throw new IllegalStateException("DATABASE_UPGRADE_REQUIRED"); }
  synchronized String readMeta(String key, String fallback) { try (Cursor cursor = getReadableDatabase().rawQuery("SELECT value FROM meta WHERE key=?", new String[]{key})) { return cursor.moveToFirst() ? cursor.getString(0) : fallback; } }
  synchronized void meta(String key, String value) { getWritableDatabase().execSQL("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)",new Object[]{key,value}); }
  synchronized List<JSONObject> rows(String table, String order) throws Exception { List<JSONObject> result = new ArrayList<>(); try (Cursor cursor = getReadableDatabase().rawQuery("SELECT body FROM " + table + " ORDER BY " + order, null)) { while (cursor.moveToNext()) result.add(new JSONObject(cursor.getString(0))); } return result; }
  synchronized List<JSONObject> messages() throws Exception { List<JSONObject> result = rows("messages", "seq DESC LIMIT 200"); Collections.reverse(result); return result; }
  static String preview(JSONObject row){JSONArray files=row.optJSONArray("attachments");if(files==null)files=row.optJSONArray("files");JSONObject file=files==null?null:files.optJSONObject(0);return MessagePresentation.preview(row.optString("text"),row.optString("device"),row.optString("client_id"),file==null?"":file.optString("mediaType"));}
  synchronized void markUnread(String id){meta("unread-v1",UnreadMessages.add(readMeta("unread-v1",""),id));}
  synchronized void markRead(){if(!readMeta("unread-v1","").isEmpty())meta("unread-v1","");}
  synchronized JSONObject inbox()throws Exception{
    JSONObject latest=null;
    try(Cursor cursor=getReadableDatabase().rawQuery("SELECT body FROM messages ORDER BY created DESC,seq DESC",null)){while(cursor.moveToNext()){JSONObject row=new JSONObject(cursor.getString(0));if(!MessagePresentation.hidden(row.optString("device"),row.optString("client_id"))){latest=row;break;}}}
    long at=latest==null?0:latest.optLong("created_at");String id=latest==null?"":latest.optString("id"),preview=latest==null?"打开聊天，继续你们的故事":preview(latest);
    for(JSONObject row:pending())if(row.optLong("queuedAt")>=at){at=row.optLong("queuedAt");id="pending-"+row.optString("clientMessageId");preview=preview(row);}
    return new JSONObject().put("id",id).put("at",at).put("preview",preview).put("unread",UnreadMessages.count(readMeta("unread-v1","")));
  }
  synchronized Set<String> messageIds(){Set<String> ids=new HashSet<>();try(Cursor cursor=getReadableDatabase().rawQuery("SELECT id FROM messages",null)){while(cursor.moveToNext())ids.add(cursor.getString(0));}return ids;}
  synchronized List<JSONObject> pending() throws Exception { return rows("outbox", "rowid"); }
  synchronized JSONObject pending(String id) throws Exception { try(Cursor cursor=getReadableDatabase().rawQuery("SELECT body FROM outbox WHERE id=?",new String[]{id})){return cursor.moveToFirst()?new JSONObject(cursor.getString(0)):null;} }
  synchronized void pending(JSONObject value) throws Exception { ContentValues data = new ContentValues(); data.put("id", value.getString("clientMessageId")); data.put("body", value.toString()); if(getWritableDatabase().update("outbox",data,"id=?",new String[]{value.getString("clientMessageId")})==0)getWritableDatabase().insertOrThrow("outbox", null, data); }
  synchronized void queueDraft(JSONObject value)throws Exception{SQLiteDatabase db=getWritableDatabase();db.beginTransaction();try{pending(value);meta("draft","");meta("draftFiles","[]");db.setTransactionSuccessful();}finally{db.endTransaction();}}
  synchronized void prune(long since) throws Exception { try(Cursor cursor=getReadableDatabase().rawQuery("SELECT id,body FROM messages WHERE created<?",new String[]{String.valueOf(since)})){while(cursor.moveToNext()){JSONObject row=new JSONObject(cursor.getString(1));if(row.optString("state").equals("completed")||row.optString("state").equals("cancelled"))getWritableDatabase().delete("messages","id=?",new String[]{cursor.getString(0)});}} }
  synchronized void remove(String id) { getWritableDatabase().delete("outbox", "id=?", new String[]{id}); }
  private void message(JSONObject value) throws Exception { getWritableDatabase().execSQL("INSERT OR REPLACE INTO messages(id,seq,created,body) VALUES(?,?,?,?)",new Object[]{value.getString("id"),value.getLong("seq"),value.getLong("created_at"),value.toString()}); }
  synchronized void cache(JSONArray values) throws Exception { SQLiteDatabase db = getWritableDatabase(); db.beginTransaction(); try { for (int i = 0; i < values.length(); i++) message(values.getJSONObject(i)); db.setTransactionSuccessful(); } finally { db.endTransaction(); } }
  synchronized void sync(JSONObject result) throws Exception {
    SQLiteDatabase db = getWritableDatabase(); db.beginTransaction();
    try {
      String oldEpoch = readMeta("epoch", ""), newEpoch = result.getString("epoch");
      if (result.optBoolean("reset")) {
        db.delete("messages", null, null);
        markRead();
        meta("historyBefore", "9223372036854775807");
        if (!oldEpoch.isEmpty() && !oldEpoch.equals(newEpoch)) for (JSONObject row : pending()) { row.put("localState", "unknown"); pending(row); }
        meta("cacheBefore", String.valueOf(result.optLong("historyBefore", 1))); meta("cacheSince", String.valueOf(result.optLong("cacheSince", 0)));
      }
      for (int i = 0; i < result.getJSONArray("messages").length(); i++) message(result.getJSONArray("messages").getJSONObject(i));
      meta("epoch", newEpoch); meta("cursor", String.valueOf(result.getLong("cursor"))); meta("mode", result.getString("mode")); meta("modeRevision", String.valueOf(result.getLong("modeRevision")));
      db.setTransactionSuccessful();
    } finally { db.endTransaction(); }
  }
}

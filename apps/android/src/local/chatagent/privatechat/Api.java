package local.chatagent.privatechat;

import java.io.*;
import java.net.*;
import javax.net.ssl.HttpsURLConnection;
import org.json.*;

final class Api {
  final String origin, token,chatId;
  Api(JSONObject config) throws Exception { origin = validOrigin(config.getString("url")); token = config.getString("token");chatId=config.optString("chatId","default");if(!chatId.equals("default")&&!chatId.matches("[a-f0-9-]{36}"))throw new Exception("INVALID_CHAT"); }
  static String validOrigin(String value) throws Exception {
    URI uri = new URI(value.trim());
    if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null || !(uri.getPath().isEmpty() || uri.getPath().equals("/"))) throw new Exception("HTTPS_ORIGIN_REQUIRED");
    return "https://" + uri.getHost() + ":" + (uri.getPort() == -1 ? 443 : uri.getPort());
  }
  byte[] exchange(String route, String method, byte[] body, String type) throws Exception {
    if(!chatId.equals("default")&&!route.equals("/v1/chats")&&!route.startsWith("/v1/pairing/"))route="/v1/chats/"+chatId+route;
    HttpsURLConnection connection = (HttpsURLConnection) new URL(origin + route).openConnection();
    connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(10000); connection.setReadTimeout(15000); connection.setRequestMethod(method);
    connection.setRequestProperty("Authorization", "Bearer " + token);
    try {
      if (body != null) { connection.setDoOutput(true); connection.setRequestProperty("Content-Type", type); connection.setFixedLengthStreamingMode(body.length); try (OutputStream output = connection.getOutputStream()) { output.write(body); } }
      int status = connection.getResponseCode();
      InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
      ByteArrayOutputStream output = new ByteArrayOutputStream();
      if (stream != null) try (InputStream input = stream) { byte[] buffer = new byte[65536]; int count; while ((count = input.read(buffer)) != -1) { if (output.size() + count > 65 * 1024 * 1024) throw new Exception("RESPONSE_TOO_LARGE"); output.write(buffer, 0, count); } }
      if (status < 200 || status >= 300) {
        String code = "HTTP_" + status;
        try { code = new JSONObject(output.toString("UTF-8")).optString("error", code); } catch (Exception ignored) { }
        throw new Exception(code);
      }
      return output.toByteArray();
    } finally { connection.disconnect(); }
  }
  Object call(String route, JSONObject body) throws Exception { return new JSONTokener(new String(exchange(route, body == null ? "GET" : "POST", body == null ? null : body.toString().getBytes("UTF-8"), "application/json"), "UTF-8")).nextValue(); }
  JSONObject object(String route, JSONObject body) throws Exception { return (JSONObject) call(route, body); }
}

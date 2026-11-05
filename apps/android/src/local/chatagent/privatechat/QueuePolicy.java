package local.chatagent.privatechat;

public final class QueuePolicy {
  public static String action(long now, long queued, long confirmed, String epoch, String currentEpoch, String mode, String currentMode, long revision, long currentRevision, String state) {
    if ("unknown".equals(state)) return "unknown";
    if (epoch == null || !epoch.equals(currentEpoch)) return "unknown";
    if (queued < 0 || now < queued || confirmed < 0 || confirmed > 0 && confirmed < queued || !mode.equals("social") && !mode.equals("assistant") || revision < 0) return "confirmation";
    long reference = confirmed > 0 ? confirmed : queued;
    if ("confirmation".equals(state) || now < reference || now - reference > 30 * 60000L || !mode.equals(currentMode) || revision != currentRevision) return "confirmation";
    return "send";
  }
}

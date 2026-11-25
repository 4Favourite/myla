package app.myla.assistant;

import android.app.SearchManager;
import android.app.admin.DevicePolicyManager;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.provider.MediaStore;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

// Myla's phone actions: open an app, ask a music app to play something, lock the screen.
// Every method answers honestly with what really happened.
@CapacitorPlugin(name = "MylaDevice")
public class MylaDevicePlugin extends Plugin {

  private static class AppEntry {
    final String label;
    final String packageName;

    AppEntry(String label, String packageName) {
      this.label = label;
      this.packageName = packageName;
    }
  }

  private List<AppEntry> launchableApps() {
    PackageManager pm = getContext().getPackageManager();
    Intent main = new Intent(Intent.ACTION_MAIN, null);
    main.addCategory(Intent.CATEGORY_LAUNCHER);
    List<ResolveInfo> infos = pm.queryIntentActivities(main, 0);
    List<AppEntry> apps = new ArrayList<>();
    Set<String> seen = new HashSet<>();
    for (ResolveInfo info : infos) {
      String pkg = info.activityInfo.packageName;
      if (!seen.add(pkg)) continue;
      CharSequence label = info.loadLabel(pm);
      apps.add(new AppEntry(label == null ? pkg : label.toString(), pkg));
    }
    Collections.sort(apps, new Comparator<AppEntry>() {
      @Override
      public int compare(AppEntry a, AppEntry b) {
        return a.label.toLowerCase(Locale.ROOT).compareTo(b.label.toLowerCase(Locale.ROOT));
      }
    });
    return apps;
  }

  private AppEntry findApp(String query) {
    String q = query.trim().toLowerCase(Locale.ROOT);
    if (q.isEmpty()) return null;
    List<AppEntry> apps = launchableApps();
    for (AppEntry a : apps) if (a.label.toLowerCase(Locale.ROOT).equals(q)) return a;
    for (AppEntry a : apps) if (a.label.toLowerCase(Locale.ROOT).startsWith(q)) return a;
    for (AppEntry a : apps) if (a.label.toLowerCase(Locale.ROOT).contains(q)) return a;
    for (AppEntry a : apps) {
      String label = a.label.toLowerCase(Locale.ROOT);
      if (label.length() > 2 && q.contains(label)) return a;
    }
    String squashed = q.replace(" ", "");
    for (AppEntry a : apps) if (a.packageName.toLowerCase(Locale.ROOT).contains(squashed)) return a;
    return null;
  }

  @PluginMethod
  public void listApps(PluginCall call) {
    JSArray list = new JSArray();
    for (AppEntry app : launchableApps()) {
      JSObject entry = new JSObject();
      entry.put("name", app.label);
      entry.put("packageName", app.packageName);
      list.put(entry);
    }
    JSObject result = new JSObject();
    result.put("apps", list);
    call.resolve(result);
  }

  @PluginMethod
  public void openApp(PluginCall call) {
    String name = call.getString("name", "");
    JSObject result = new JSObject();
    AppEntry app = findApp(name);
    if (app == null) {
      result.put("opened", false);
      result.put("reason", "No app named \"" + name + "\" was found on this phone.");
      call.resolve(result);
      return;
    }
    Intent intent = getContext().getPackageManager().getLaunchIntentForPackage(app.packageName);
    if (intent == null) {
      result.put("opened", false);
      result.put("reason", app.label + " has no screen that can be opened.");
      call.resolve(result);
      return;
    }
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    try {
      getContext().startActivity(intent);
      result.put("opened", true);
      result.put("label", app.label);
      result.put("packageName", app.packageName);
    } catch (Exception e) {
      result.put("opened", false);
      result.put("reason", "Android would not open " + app.label + ": " + e.getMessage());
    }
    call.resolve(result);
  }

  @PluginMethod
  public void playMusic(PluginCall call) {
    String query = call.getString("query", "");
    String pkg = call.getString("packageName", "");
    JSObject result = new JSObject();
    if (query.trim().isEmpty()) {
      result.put("started", false);
      result.put("reason", "There was nothing to play.");
      call.resolve(result);
      return;
    }
    Intent intent = new Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH);
    intent.putExtra(MediaStore.EXTRA_MEDIA_FOCUS, "vnd.android.cursor.item/*");
    intent.putExtra(SearchManager.QUERY, query);
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    if (!pkg.isEmpty()) intent.setPackage(pkg);
    try {
      getContext().startActivity(intent);
      result.put("started", true);
      if (!pkg.isEmpty()) {
        AppEntry chosen = findApp(pkg);
        if (chosen != null) result.put("label", chosen.label);
      }
    } catch (ActivityNotFoundException e) {
      Intent launch = pkg.isEmpty() ? null : getContext().getPackageManager().getLaunchIntentForPackage(pkg);
      if (launch != null) {
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
          getContext().startActivity(launch);
          result.put("started", false);
          result.put("opened_app_only", true);
        } catch (Exception inner) {
          result.put("started", false);
          result.put("reason", "The music app would not open: " + inner.getMessage());
        }
      } else {
        result.put("started", false);
        result.put("reason", "No music app on this phone accepted a play request. Choose your music app in the This phone panel.");
      }
    } catch (Exception e) {
      result.put("started", false);
      result.put("reason", "Android would not start the music: " + e.getMessage());
    }
    call.resolve(result);
  }

  private ComponentName adminComponent() {
    return new ComponentName(getContext(), MylaAdminReceiver.class);
  }

  @PluginMethod
  public void adminStatus(PluginCall call) {
    DevicePolicyManager dpm = (DevicePolicyManager) getContext().getSystemService(Context.DEVICE_POLICY_SERVICE);
    JSObject result = new JSObject();
    result.put("active", dpm != null && dpm.isAdminActive(adminComponent()));
    call.resolve(result);
  }

  @PluginMethod
  public void requestAdmin(PluginCall call) {
    Intent intent = new Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN);
    intent.putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, adminComponent());
    intent.putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION, "This lets Myla lock your screen when you ask. It cannot do anything else.");
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    JSObject result = new JSObject();
    try {
      getContext().startActivity(intent);
      result.put("requested", true);
    } catch (Exception e) {
      result.put("requested", false);
    }
    call.resolve(result);
  }

  @PluginMethod
  public void lockScreen(PluginCall call) {
    DevicePolicyManager dpm = (DevicePolicyManager) getContext().getSystemService(Context.DEVICE_POLICY_SERVICE);
    JSObject result = new JSObject();
    if (dpm == null || !dpm.isAdminActive(adminComponent())) {
      result.put("locked", false);
      result.put("reason", "Myla is not allowed to lock the screen yet. Tap Allow locking in the This phone panel.");
      call.resolve(result);
      return;
    }
    try {
      dpm.lockNow();
      result.put("locked", true);
    } catch (Exception e) {
      result.put("locked", false);
      result.put("reason", "Android would not lock the screen: " + e.getMessage());
    }
    call.resolve(result);
  }
}

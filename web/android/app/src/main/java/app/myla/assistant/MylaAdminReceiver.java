package app.myla.assistant;

import android.app.admin.DeviceAdminReceiver;

// Lets the user allow Myla to lock the screen. It can do nothing else:
// the only policy requested (see res/xml/device_admin.xml) is "force lock".
public class MylaAdminReceiver extends DeviceAdminReceiver {}

package app.myla.assistant;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

  @Override
  public void onCreate(Bundle savedInstanceState) {
    // Register Myla's own phone-actions plugin before the app starts.
    registerPlugin(MylaDevicePlugin.class);
    super.onCreate(savedInstanceState);
  }
}

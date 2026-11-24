package __APP_ID__

import android.os.Bundle
import com.getcapacitor.BridgeActivity
import com.techverse.quranbangla.bridge.QuranNativePlugin

/**
 * The only Activity of the app. Capacitor 3+ does not discover local plugins by itself: they must be registered here,
 * BEFORE super.onCreate. (android-build/apply-native-patches.mjs replaces the generated MainActivity.java with this file.)
 */
class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(QuranNativePlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}

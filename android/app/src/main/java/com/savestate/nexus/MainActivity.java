package com.savestate.nexus;

import android.os.Bundle;
import android.webkit.URLUtil;
import android.webkit.WebView;
import android.widget.Toast;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NxAndroidPlugin.class);
        super.onCreate(savedInstanceState);
        // A WebView drops downloads unless something takes them: links the
        // page downloads (a game's Download button, an export) go to Android's
        // download manager, into Downloads/SaveState. Files the page builds
        // itself (blob: addresses) are read back by the page and saved through
        // NxAndroid.saveData.
        WebView web = getBridge().getWebView();
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> {
            if (url.startsWith("blob:")) {
                String name = URLUtil.guessFileName(url, disposition, mime);
                web.evaluateJavascript("window.nxSaveBlob&&window.nxSaveBlob(" + org.json.JSONObject.quote(url) + "," + org.json.JSONObject.quote(name) + ")", null);
                return;
            }
            if (!url.startsWith("http")) return;
            try {
                String name = URLUtil.guessFileName(url, disposition, mime);
                NxAndroidPlugin.enqueue(this, url, "", name, "", name);
                Toast.makeText(this, "Downloading " + name + " to Downloads/SaveState", Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(this, "Couldn't download it: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        });
    }
}

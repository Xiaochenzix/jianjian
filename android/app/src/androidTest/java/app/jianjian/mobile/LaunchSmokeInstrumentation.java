package app.jianjian.mobile;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Runs the real launch path on a device; needs no third-party test libraries. */
public final class LaunchSmokeInstrumentation extends Instrumentation {
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }

    private WebView findWebView(View view) {
        if (view instanceof WebView) return (WebView) view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                WebView found = findWebView(group.getChildAt(i));
                if (found != null) return found;
            }
        }
        return null;
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            Intent launch = new Intent(getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            Activity activity = startActivitySync(launch);
            waitForIdleSync();
            AtomicReference<WebView> web = new AtomicReference<>();
            AtomicReference<Throwable> failure = new AtomicReference<>();
            runOnMainSync(() -> {
                try {
                    if (activity.isFinishing() || activity.isDestroyed()) throw new AssertionError("Activity exited during launch");
                    web.set(findWebView(activity.findViewById(android.R.id.content)));
                    if (web.get() == null) throw new AssertionError("WebView was not created");
                    if (Build.VERSION.SDK_INT >= 30 && activity.getWindow().getInsetsController() == null) throw new AssertionError("Insets controller missing after content creation");
                } catch (Throwable error) { failure.set(error); }
            });
            if (failure.get() != null) throw new AssertionError("Native launch failed", failure.get());
            // Wait for the real bundled page and bridge, not a fixture HTML document.
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
            boolean ready = false;
            while (!ready && System.nanoTime() < deadline) {
                CountDownLatch evaluated = new CountDownLatch(1);
                AtomicReference<String> answer = new AtomicReference<>();
                runOnMainSync(() -> web.get().evaluateJavascript(
                    "document.readyState === 'complete' && !!document.getElementById('login-form') && typeof window.__nativeEvent === 'function'",
                    value -> { answer.set(value); evaluated.countDown(); }));
                if (!evaluated.await(3, TimeUnit.SECONDS)) throw new AssertionError("WebView did not respond");
                ready = "true".equals(answer.get());
                if (!ready) Thread.sleep(150);
            }
            if (!ready) throw new AssertionError("Bundled login page did not finish loading");
            result.putString("stream", "PASS: real Activity, system-bar controller, local login page and native bridge\n");
            finish(Activity.RESULT_OK, result);
        } catch (Throwable error) {
            result.putString("stream", "FAIL: " + android.util.Log.getStackTraceString(error));
            finish(Activity.RESULT_CANCELED, result);
        }
    }
}

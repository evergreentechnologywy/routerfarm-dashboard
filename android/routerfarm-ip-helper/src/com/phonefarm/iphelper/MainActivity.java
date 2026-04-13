package com.phonefarm.iphelper;

import android.app.Activity;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkInfo;
import android.os.Bundle;
import android.util.Log;
import android.widget.TextView;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends Activity {
    private static final String TAG = "RouterFarmIpHelper";
    private static final Pattern TRACE_IP_PATTERN = Pattern.compile("(?m)^ip=(\\d{1,3}(?:\\.\\d{1,3}){3})$");
    private static final Pattern IPV4_PATTERN = Pattern.compile("\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b");
    private static final Pattern IPV6_PATTERN = Pattern.compile("\\b(?:[a-fA-F0-9]{1,4}:){2,}[a-fA-F0-9]{1,4}\\b");

    private TextView statusView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        statusView = new TextView(this);
        statusView.setPadding(32, 32, 32, 32);
        statusView.setTextSize(18f);
        statusView.setText("Checking phone network path...");
        setContentView(statusView);

        final String requestId = getIntent().getStringExtra("requestId") != null
            ? getIntent().getStringExtra("requestId")
            : String.valueOf(System.currentTimeMillis());

        new Thread(() -> {
            Result result = runIpCheck(requestId);
            writeResult(result);
            runOnUiThread(() -> {
                statusView.setText(result.success ? result.ip : result.error);
                finishAndRemoveTask();
            });
        }, "phonefarm-ip-check").start();
    }

    private Result runIpCheck(String requestId) {
        Result result = new Result();
        result.requestId = requestId;
        result.checkedAt = isoNow();
        result.network = getNetworkDescription();

        Endpoint[] endpoints = new Endpoint[] {
            new Endpoint("cloudflare-trace-1.1.1.1", "http://1.1.1.1/cdn-cgi/trace"),
            new Endpoint("cloudflare-trace-1.0.0.1", "http://1.0.0.1/cdn-cgi/trace"),
            new Endpoint("ipify-json", "https://api64.ipify.org?format=json"),
            new Endpoint("ipify-json-fallback", "https://api.ipify.org?format=json"),
            new Endpoint("ifconfigme", "https://ifconfig.me/ip"),
            new Endpoint("ipinfo", "https://ipinfo.io/ip")
        };

        String lastError = "No phone-side IP endpoint returned a valid public IP.";
        for (Endpoint endpoint : endpoints) {
            try {
                String body = fetch(endpoint.url);
                String ip = parseIp(body);
                if (!ip.isEmpty()) {
                    result.success = true;
                    result.ip = ip;
                    result.source = endpoint.name;
                    result.error = "";
                    return result;
                }
                lastError = "Endpoint responded but no public IP was detected.";
            } catch (Exception ex) {
                lastError = ex.getMessage() != null ? ex.getMessage() : ex.getClass().getSimpleName();
            }
        }

        result.success = false;
        result.ip = "";
        result.source = "";
        result.error = lastError;
        return result;
    }

    private String fetch(String targetUrl) throws Exception {
        HttpURLConnection connection = null;
        InputStream stream = null;
        try {
            URL url = new URL(targetUrl);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(10000);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("User-Agent", "RouterFarmIpHelper/1.0");
            connection.setUseCaches(false);
            connection.connect();

            int code = connection.getResponseCode();
            stream = code >= 200 && code < 400
                ? connection.getInputStream()
                : connection.getErrorStream();
            if (stream == null) {
                throw new IllegalStateException("No response body from " + targetUrl);
            }

            BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8));
            StringBuilder body = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                body.append(line).append('\n');
            }

            if (code < 200 || code >= 400) {
                throw new IllegalStateException("HTTP " + code + " from " + targetUrl);
            }
            return body.toString().trim();
        } finally {
            if (stream != null) {
                try {
                    stream.close();
                } catch (Exception ignored) {
                }
            }
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private String parseIp(String text) {
        if (text == null) {
            return "";
        }

        Matcher trace = TRACE_IP_PATTERN.matcher(text);
        if (trace.find()) {
            return trace.group(1);
        }

        Matcher json = Pattern.compile("\"ip\"\\s*:\\s*\"([^\"]+)\"").matcher(text);
        if (json.find()) {
            return json.group(1).trim();
        }

        Matcher ipv4 = IPV4_PATTERN.matcher(text);
        if (ipv4.find()) {
            return ipv4.group();
        }

        Matcher ipv6 = IPV6_PATTERN.matcher(text);
        if (ipv6.find()) {
            return ipv6.group();
        }

        return "";
    }

    private String getNetworkDescription() {
        try {
            ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager == null) {
                return "unavailable";
            }

            Network activeNetwork = manager.getActiveNetwork();
            NetworkCapabilities capabilities = activeNetwork != null ? manager.getNetworkCapabilities(activeNetwork) : null;
            if (capabilities != null) {
                if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
                    return "cellular";
                }
                if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    return "wifi";
                }
                if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
                    return "ethernet";
                }
                if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
                    return "vpn";
                }
                return "other";
            }

            NetworkInfo info = manager.getActiveNetworkInfo();
            if (info != null) {
                return info.getTypeName().toLowerCase();
            }
        } catch (Exception ignored) {
        }

        return "unknown";
    }

    private void writeResult(Result result) {
        try {
            JSONObject json = new JSONObject();
            json.put("success", result.success);
            json.put("requestId", result.requestId);
            json.put("checkedAt", result.checkedAt);
            json.put("ip", result.ip);
            json.put("source", result.source);
            json.put("network", result.network);
            json.put("error", result.error);

            File output = new File(getFilesDir(), "ip-check-result.json");
            try (FileOutputStream stream = new FileOutputStream(output, false)) {
                stream.write(json.toString().getBytes(StandardCharsets.UTF_8));
            }

            Log.i(TAG, json.toString());
        } catch (Exception ex) {
            Log.e(TAG, "Failed to write IP check result", ex);
        }
    }

    private String isoNow() {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date());
    }

    private static final class Endpoint {
        final String name;
        final String url;

        Endpoint(String name, String url) {
            this.name = name;
            this.url = url;
        }
    }

    private static final class Result {
        boolean success;
        String requestId;
        String checkedAt;
        String ip;
        String source;
        String network;
        String error;
    }
}

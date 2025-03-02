import * as LunarCalendar from "lunar-calendar";
import * as vscode from "vscode";

interface ThemeConfig {
    mode: "auto" | "manual";
    daytime: {
        start: string;
        end: string;
        theme: string;
    };
    nighttime: {
        start: string;
        end: string;
        theme: string;
    };
    latitude?: number; // 新增纬度
    longitude?: number; // 新增经度
    currentTheme: string;
}

interface SunApiResponse {
    status: "OK" | "INVALID_REQUEST" | "INVALID_DATE" | "UNKNOWN_ERROR";
    results: {
        sunrise: string;
        sunset: string;
    };
}

interface ThemeInfo {
    label: string;
    themeId: string;
    uiTheme: string;
    extensionId: string;
    path?: string;
}

interface WeatherApiResponse {
    current: {
        temperature_2m: number;
        weather_code: number;
        wind_speed_10m: number;
    };
}

// 新增IP定位接口
interface IpGeoResponse {
    ip: string;
    city: string;
    region: string;
    country: string;
    country_name: string;
    latitude: number;
    longitude: number;
}

export function activate(context: vscode.ExtensionContext) {
    const currentTheme = vscode.workspace.getConfiguration().get("workbench.colorTheme");

    let config: ThemeConfig = {
        mode: "auto",
        daytime: { start: "08:00", end: "18:00", theme: "" },
        nighttime: { start: "19:00", end: "07:00", theme: "" },
        // 默认北京坐标
        latitude: 39.9042,
        longitude: 116.4074,
        currentTheme: currentTheme as string,
    };

    const allThemes = getAllColorThemes();
    console.log("所有颜色主题:", allThemes);

    // Webview视图提供器
    const provider = {
        resolveWebviewView(webviewView: vscode.WebviewView) {
            webviewView.webview.options = { enableScripts: true };

            const updateWebview = () => {
                webviewView.webview.html = getWebviewContent(config, webviewView.webview);
            };

            webviewView.webview.onDidReceiveMessage(async (message) => {
                switch (message.type) {
                    case "updateConfig":
                        config = { ...config, ...message.config };
                        break;

                    case "applyConfig":
                        try {
                            const targetTheme = getCurrentTheme();
                            if (targetTheme) {
                                await vscode.workspace.getConfiguration().update("workbench.colorTheme", targetTheme, vscode.ConfigurationTarget.Global);
                                vscode.window.showInformationMessage(`主题已应用: ${targetTheme}`);
                            }
                        } catch (error) {
                            vscode.window.showErrorMessage(`主题设置失败: ${error}`);
                        }
                        break;

                    case "showWarning":
                        vscode.window.showWarningMessage(message.message);
                        break;
                    case "getSunTimes":
                        if (!config.latitude || !config.longitude) {
                            vscode.window.showWarningMessage("正在获取定位信息...");
                            return;
                        }
                        const sunApiUrl = `https://api.sunrise-sunset.org/json?lat=${config.latitude}&lng=${config.longitude}&formatted=0&date=${message.date}`;
                        fetch(sunApiUrl)
                            .then((response) => response.json() as Promise<SunApiResponse>)
                            .then((data) => {
                                if (typeof data === "object" && data !== null && "status" in data) {
                                    const apiData = data as SunApiResponse;
                                    if (apiData.status === "OK") {
                                        const formatTime = (utc: string) =>
                                            new Date(utc).toLocaleTimeString("zh-CN", {
                                                hour12: false,
                                                hour: "2-digit",
                                                minute: "2-digit",
                                            });
                                        webviewView.webview.postMessage({
                                            type: "sunTimes",
                                            sunrise: formatTime(data.results.sunrise),
                                            sunset: formatTime(data.results.sunset),
                                        });
                                        // 更新配置中的实际日出日落时间
                                        config.daytime.start = formatTime(data.results.sunrise);
                                        config.daytime.end = formatTime(data.results.sunset);
                                        config.nighttime.start = formatTime(data.results.sunset);
                                        config.nighttime.end = formatTime(data.results.sunrise);

                                        // 强制刷新Webview显示
                                        updateWebview();
                                        webviewView.webview.postMessage({
                                            type: "sunTimes",
                                            sunrise: formatTime(data.results.sunrise),
                                            sunset: formatTime(data.results.sunset),
                                        });
                                        // 添加调度刷新
                                        scheduleCheck();
                                    }
                                }
                            })
                            .catch((error) => {
                                vscode.window.showErrorMessage(`获取日出时间失败: ${error}`);
                                console.error("API请求错误:", error);
                            });
                        break;
                    case "getLunarDate":
                        try {
                            const solarDate = new Date(message.date);
                            const lunarData = LunarCalendar.solarToLunar(solarDate.getFullYear(), solarDate.getMonth() + 1, solarDate.getDate());
                            webviewView.webview.postMessage({
                                type: "lunarDate",
                                data: {
                                    year: lunarData.lunarYear,
                                    month: lunarData.lunarMonthName,
                                    day: lunarData.lunarDayName,
                                },
                            });
                        } catch (error) {
                            console.error("农历计算失败:", error);
                            webviewView.webview.postMessage({
                                type: "lunarDate",
                                data: { year: "----", month: "--", day: "--" },
                            });
                        }
                        break;
                    case "getAllThemes":
                        webviewView.webview.postMessage({
                            type: "themeList",
                            themes: getAllColorThemes(),
                        });
                        break;
                    case "getWeather":
                        if (!config.latitude || !config.longitude) {
                            vscode.window.showWarningMessage("正在获取定位信息...");
                            return;
                        }
                        const weatherApiUrl = `https://api.open-meteo.com/v1/forecast?latitude=${config.latitude}&longitude=${config.longitude}&current=temperature_2m,weather_code,wind_speed_10m`;
                        fetch(weatherApiUrl)
                            .then((response) => response.json() as Promise<WeatherApiResponse>)
                            .then((data) => {
                                webviewView.webview.postMessage({
                                    type: "weatherUpdate",
                                    temp: data.current.temperature_2m,
                                    code: data.current.weather_code,
                                    wind: data.current.wind_speed_10m,
                                });
                            })
                            .catch((error) => {
                                console.error("天气请求失败:", error);
                            });
                        break;
                    case "getLocation":
                        const fetchWithFallback = async () => {
                            const apis = ["https://ipapi.co/json/", "https://api.ip.sb/geoip"];

                            for (const url of apis) {
                                try {
                                    const response = await fetch(url, {
                                        headers: { Accept: "application/json" },
                                    });

                                    if (!response.ok) continue;

                                    const data = (await response.json()) as IpGeoResponse;

                                    // 标准化数据格式
                                    const standardized = {
                                        ip: data.ip,
                                        city: data.city || "Unknown",
                                        region: data.region || "Unknown",
                                        country_name: data.country_name || data.country || "Unknown",
                                        latitude: data.latitude,
                                        longitude: data.longitude,
                                    };

                                    if (!standardized.latitude || !standardized.longitude) continue;

                                    return standardized;
                                } catch (error) {
                                    console.debug(`定位API ${url} 请求失败:`, error);
                                }
                            }
                            throw new Error("所有定位API请求失败");
                        };

                        fetchWithFallback()
                            .then((data) => {
                                config.latitude = data.latitude;
                                config.longitude = data.longitude;

                                webviewView.webview.postMessage({
                                    type: "locationUpdate",
                                    ip: data.ip,
                                    location: `${data.city}, ${data.region}, ${data.country_name}`,
                                    coordinates: `${data.latitude.toFixed(4)}, ${data.longitude.toFixed(4)}`,
                                });

                                webviewView.webview.postMessage({
                                    type: "locationStatus",
                                    status: "success",
                                });
                            })
                            .catch((error) => {
                                console.error("所有定位服务不可用:", error);
                                // 回退到默认坐标
                                config.latitude = 39.9042;
                                config.longitude = 116.4074;

                                vscode.window.showWarningMessage("自动定位失败，使用北京默认坐标");

                                webviewView.webview.postMessage({
                                    type: "locationUpdate",
                                    ip: "N/A",
                                    location: "中国北京",
                                    coordinates: "39.9042, 116.4074",
                                });

                                webviewView.webview.postMessage({
                                    type: "locationStatus",
                                    status: "failed",
                                });
                            });
                        break;
                }
            });

            updateWebview();
        },
    };

    context.subscriptions.push(vscode.window.registerWebviewViewProvider("auto-theme.configView", provider));

    // 获取当前应该应用的主题
    const getCurrentTheme = (): string | null => {
        const now = new Date();

        if (config.mode === "auto") {
            // 将API返回的日出日落时间转换为Date对象
            const parseApiTime = (timeString: string) => {
                const [h, m] = timeString.split(":").map(Number);
                const date = new Date();
                date.setHours(h, m, 0, 0);
                return date;
            };

            const sunrise = parseApiTime(config.daytime.start);
            const sunset = parseApiTime(config.nighttime.start);

            // 判断当前时间是否在日出到日落之间
            const isDaytime = now >= sunrise && now <= sunset;
            return isDaytime ? config.daytime.theme : config.nighttime.theme;
        }

        // 手动模式保持原有逻辑
        return isTimeBetween(now, parseTimeRange(config.daytime)) ? config.daytime.theme : config.nighttime.theme;
    };

    // 时间检测逻辑
    const checkTime = () => {
        const targetTheme = getCurrentTheme();
        if (targetTheme) {
            vscode.workspace.getConfiguration().update("workbench.colorTheme", targetTheme, vscode.ConfigurationTarget.Global);
        }
    };

    // 智能调度器
    let timer: NodeJS.Timeout;
    const scheduleCheck = () => {
        if (config.mode !== "auto") return;

        const now = new Date();
        const nextDay = getNextTimePoint(now, parseTimeRange(config.daytime));
        const nextNight = getNextTimePoint(now, parseTimeRange(config.nighttime));

        const nextCheck = [nextDay, nextNight].reduce((a, b) => (a < b ? a : b));
        const delay = nextCheck.getTime() - now.getTime();

        clearTimeout(timer);
        timer = setTimeout(() => {
            checkTime();
            scheduleCheck();
        }, Math.max(delay, 1000));
    };

    // 辅助函数
    const parseTimeRange = (range: { start: string; end: string }) => {
        const [startH, startM] = range.start.split(":").map(Number);
        const [endH, endM] = range.end.split(":").map(Number);
        return { startH, startM, endH, endM };
    };

    const isTimeBetween = (now: Date, time: ReturnType<typeof parseTimeRange>) => {
        const start = new Date(now);
        start.setHours(time.startH, time.startM, 0, 0);

        let end = new Date(now);
        end.setHours(time.endH, time.endM, 0, 0);

        if (end <= start) end.setDate(end.getDate() + 1);
        return now >= start && now <= end;
    };

    const getNextTimePoint = (now: Date, time: ReturnType<typeof parseTimeRange>) => {
        const start = new Date(now);
        start.setHours(time.startH, time.startM, 0, 0);

        let end = new Date(now);
        end.setHours(time.endH, time.endM, 0, 0);

        if (end <= start) end.setDate(end.getDate() + 1);

        if (now < start) return start;
        if (now < end) return end;
        return new Date(start.setDate(start.getDate() + 1));
    };

    // 初始化
    scheduleCheck();
    context.subscriptions.push({
        dispose: () => timer && clearTimeout(timer),
    });
}

// Webview内容生成
function getWebviewContent(config: ThemeConfig, webview: vscode.Webview) {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
    .config-container { padding: 20px; }
    .mode-selector { 
        display: flex;
        gap: 10px;  /* 缩小间距 */
        align-items: stretch;  /* 垂直对齐优化 */
        margin-bottom: 40px; 
    }
    
    /* 新增选择框样式 */
    .mode-selector select {
        width: 200px;
        padding: 6px 8px;
        font-size: 13px;
        background: var(--vscode-dropdown-background);
        color: var(--vscode-dropdown-foreground);
        border: 1px solid var(--vscode-dropdown-border);
        border-radius: 2px;
        cursor: pointer;
        transition: background 0.2s ease;
    }
    
    .mode-selector select:hover {
        background: var(--vscode-dropdown-listBackground);
    }
    
    .mode-selector select:focus {
        outline: 1px solid var(--vscode-focusBorder);
    }

    /* 修改按钮样式 */
    #saveBtn {
        padding: 6px 12px;
        font-size: 12px;
        min-width: 80px;
        transition: all 0.2s ease;
    }

    #saveBtn:hover {
        transform: scale(1.05);
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }

    /* 保持原有其他样式... */
    .time-grid {
        display: grid;
        gap: 15px;
    }
    .time-group {
        border: 1px solid var(--vscode-editorWidget-border);
        padding: 15px;
        border-radius: 4px;
    }
    .time-row {
        display: flex;
        gap: 10px;
        margin: 10px 0;
        align-items: center;
        width: 100%;
        position: relative;
    }
        .time-row.manual-only {
    transition: opacity 0.3s ease;
}

.time-row.manual-only[style*="display: none"] {
    opacity: 0;
    height: 0;
    margin: 0;
    overflow: hidden;
}
    input[type="time"] {
        width: 244px;
        padding: 6px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border);
        flex-shrink: 0;
    }
    input[type="text"] {
        width: 100%;
        padding: 8px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border);
    }
    button {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        padding: 8px 16px;
        border-radius: 2px;
        cursor: pointer;
    }
    button:hover {
        background: var(--vscode-button-hoverBackground);
    }
    .hint {
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
        margin-top: 5px;
    }
    .btn-loading {
        opacity: 0.7;
        cursor: wait;
    }
        #timeDisplay {
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-editorWidget-border);
    padding: 12px;
    border-radius: 4px;
    margin-bottom: 15px;
    transition: opacity 0.3s ease;
}

#currentTime {
    color: var(--vscode-terminal-ansiBrightYellow);
    font-weight: 600;
    letter-spacing: 0.5px;
}
    .time-grid, .hint, #timeDisplay {
    transition: opacity 0.3s ease, transform 0.3s ease;
}

[style*="display: none"] {
    opacity: 0;
    transform: translateY(-10px);
    pointer-events: none;
}

[style*="display: block"], 
[style*="display: grid"] {
    opacity: 1;
    transform: translateY(0);
}
    #lunarDate {
    font-weight: 500;
}
    #currentDate {
    font-weight: 500;
}
#weekDay {
    margin-left: 8px;
    font-weight: 500;
}
    .theme-selector {
    width: 100%;
    padding: 8px;
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
}

.theme-selector optgroup {
    font-style: normal;
    padding: 5px 0;
    border-bottom: 1px solid var(--vscode-editorWidget-border);
}
.weather-info {
    display: flex;
    gap: 20px;
    align-items: center;
    margin-left: auto; 
    padding-left: 20px; 
}
    .weather-item {
    display: flex;
    align-items: center;
    gap: 5px;
    position: relative;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    padding: 6px 12px;
    border-radius: 4px;
    background: var(--vscode-button-secondaryBackground);
}

.weather-item:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    background: var(--vscode-button-secondaryHoverBackground);
}

.weather-icon {
    transition: transform 0.3s ease;
}

.weather-item:hover .weather-icon {
    transform: scale(1.2) rotate(10deg);
}

/* Tooltip样式 */
.tooltip {
    visibility: hidden;
    position: absolute;
    bottom: -130%;
    left: 50%;
    transform: translateX(-50%);
    background: var(--vscode-editorWidget-background);
    color: var(--vscode-editorWidget-foreground);
    padding: 6px 12px;
    border-radius: 4px;
    font-size: 0.9em;
    white-space: nowrap;
    border: 1px solid var(--vscode-editorWidget-border);
    opacity: 0;
    transition: opacity 0.2s ease;
}

.tooltip::after {
    content: "";
    position: absolute;
    bottom: 100%;
    left: 50%;
    margin-left: -5px;
    border-width: 5px;
    border-style: solid;
    border-color: transparent transparent var(--vscode-editorWidget-background) transparent;
}

.weather-item:hover .tooltip {
    visibility: visible;
    opacity: 1;
}

/* 移动端适配 */
@media (max-width: 600px) {
    .weather-info {
        gap: 12px;
    }
    .weather-item {
        padding: 4px 8px;
    }
    .tooltip {
        font-size: 0.8em;
    }
}
    /* 定位信息样式 */
#locationInfo {
    position: fixed;
    bottom: 5px;
    right: 40px;
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-editorWidget-border);
    padding: 12px;
    border-radius: 8px;
    font-size: 0.9em;
    max-width: 300px;
    backdrop-filter: blur(4px);
    opacity: 0.6;
    transition: opacity 0.3s ease;
}

#locationInfo:hover {
    opacity: 1;
}

.location-item {
    display: flex;
    align-items: center;
    margin: 4px 0;
}

.location-icon {
    margin-right: 8px;
    font-size: 1.1em;
}

.location-label {
    color: var(--vscode-descriptionForeground);
    min-width: 60px;
}

.location-value {
    color: var(--vscode-foreground);
    word-break: break-all;
}
</style>
    </head>
    <body>
        <div class="config-container">
        <div class="mode-selector">
            <select id="modeSelect">
                <option value="manual" ${config.mode === "manual" ? "selected" : ""}>手动模式</option>
                <option value="auto" ${config.mode === "auto" ? "selected" : ""}>自动模式</option>
            </select>
            <button id="saveBtn">应用配置</button>
            <!-- 将天气信息移动到这里 -->
    <div class="weather-info">
    <div class="weather-item" data-desc="天气状态">
        <span class="weather-icon" id="weatherIcon">⛅</span>
        <span id="weatherTemp">--°C</span>
        <span class="tooltip">多云转晴</span>
    </div>
    <div class="weather-item" data-desc="风速级别">
        💨 <span id="weatherWind">-- km/h</span>
        <span class="tooltip">3级和风</span>
    </div>
</div>
        </div>
        <!-- 时间显示区域 -->
        <div id="timeDisplay" style="display: ${config.mode === "auto" ? "block" : "none"}">
    <div>📅&nbsp;&nbsp;阳历：<span id="currentDate">${new Date().toLocaleDateString("zh-CN")}</span>&nbsp;&nbsp;农历：<span id="lunarDate"></span><span id="weekDay"></span>
    </div>
    <div>🕒&nbsp;&nbsp;当前时间：<span id="currentTime">${new Date().toLocaleTimeString("zh-CN", { hour12: false })}</span></div>
    <div>🌅&nbsp;&nbsp;日出：<span id="sunriseTime"></span>&nbsp;&nbsp;🌇&nbsp;&nbsp;日落：<span id="sunsetTime"></span></div>
</div>

        <!-- 修改时间设置区域 -->
<div class="time-grid" style="display: grid"> <!-- 始终显示 -->
    <div class="time-group">
        <h3>${config.mode === "auto" ? "自动模式设置" : "白天主题设置"}
            <span style="font-size:0.8em;color:#666">(${config.daytime.start} - ${config.daytime.end})</span>
        </h3>
        <div class="time-row manual-only" style="${config.mode === "auto" ? "display:none" : ""}"> <!-- 隐藏时间输入 -->
            <input type="time" id="dayStart" value="${config.daytime.start}" ${config.mode === "auto" ? "disabled" : ""}>
            <span>至</span>
            <input type="time" id="dayEnd" value="${config.daytime.end}" ${config.mode === "auto" ? "disabled" : ""}>
        </div>
        <div class="time-row manual-only">
            <select id="dayTheme" class="theme-selector">
                <option value="" hidden>请选择白天主题，如Default Light+</option>
                <optgroup label="浅色主题" id="dayThemes"></optgroup>
            </select>
        </div>
    </div>

    <div class="time-group">
        <h3>${config.mode === "auto" ? "自动模式设置" : "夜间主题设置"}
            <span style="font-size:0.8em;color:#666">(${config.nighttime.start} - ${config.nighttime.end})</span>
        </h3>
        <div class="time-row manual-only" style="${config.mode === "auto" ? "display:none" : ""}"> <!-- 隐藏时间输入 -->
            <input type="time" id="nightStart" value="${config.nighttime.start}" ${config.mode === "auto" ? "disabled" : ""}>
            <span>至</span>
            <input type="time" id="nightEnd" value="${config.nighttime.end}" ${config.mode === "auto" ? "disabled" : ""}>
        </div>
        <div class="time-row manual-only">
            <select id="nightTheme" class="theme-selector">
                <option value="" hidden>请选择夜间主题，如Default Dark+</option>
                <optgroup label="深色主题" id="nightThemes"></optgroup>
            </select>
        </div>
    </div>
</div>

        
        <div class="hint" style="display: block">
            当前主题：${config.currentTheme}，在VS Code设置中查看准确的主题名称（文件 > 首选项 > 主题）
        </div>
    </div>

    <!-- 定位信息 -->
<div id="locationInfo">
<div class="location-item" id="loadingLocation">
    <span class="location-icon">⏳</span>
    <div class="location-value">正在获取定位信息...</div>
</div>
    <div class="location-item">
        <span class="location-icon">🌐</span>
        <div>
            <div class="location-label">IP地址</div>
            <div class="location-value" id="ipAddress">获取中...</div>
        </div>
    </div>
    <div class="location-item">
        <span class="location-icon">📍</span>
        <div>
            <div class="location-label">位置</div>
            <div class="location-value" id="geoLocation">获取中...</div>
        </div>
    </div>
    <div class="location-item">
        <span class="location-icon">🧭</span>
        <div>
            <div class="location-label">坐标</div>
            <div class="location-value" id="geoCoordinates">获取中...</div>
        </div>
    </div>
</div>

        <script>
    const vscode = acquireVsCodeApi();
    let currentConfig = ${JSON.stringify(config)};
    let isApplying = false;

    // 监听定位状态
window.addEventListener('message', event => {
    if (event.data.type === 'locationStatus') {
        document.getElementById('loadingLocation').style.display = 
            event.data.status === 'success' ? 'none' : 'block';
    }
});


    // 在模式切换事件中增加控制逻辑
    document.getElementById('modeSelect').addEventListener('change', function() {
        const isAutoMode = this.value === 'auto';

        // 只控制时间显示区域
    document.getElementById('timeDisplay').style.display = isAutoMode ? 'block' : 'none';
    // 单独控制时间输入框的显示
    document.querySelectorAll('.time-row[style]').forEach(row => {
        row.style.display = isAutoMode ? 'none' : 'flex';
    });
        // 更新提示区域
    document.querySelector('.hint').style.display = 'block';
    });

    function updateConfig() {
        currentConfig = {
            mode: document.getElementById('modeSelect').value,
            daytime: {
                start: document.getElementById('dayStart').value,
                end: document.getElementById('dayEnd').value,
                theme: document.getElementById('dayTheme').value.trim()
            },
            nighttime: {
                start: document.getElementById('nightStart').value,
                end: document.getElementById('nightEnd').value,
                theme: document.getElementById('nightTheme').value.trim()
            }
        };
        vscode.postMessage({ type: 'updateConfig', config: currentConfig });
    }

    ['modeSelect', 'dayStart', 'dayEnd', 'dayTheme', 
     'nightStart', 'nightEnd', 'nightTheme'].forEach(id => {
        const element = document.getElementById(id);
        element.addEventListener('change', updateConfig);
        element.addEventListener('input', updateConfig);
    });

    document.getElementById('saveBtn').addEventListener('click', async () => {
        if (isApplying) return;
        
        const btn = document.getElementById('saveBtn');
        const themesValid = [currentConfig.daytime.theme, currentConfig.nighttime.theme]
            .every(t => t.trim().length > 0);
        
        if (!themesValid) {
            vscode.postMessage({
                type: 'showWarning',
                message: '请填写完整的主题名称'
            });
            return;
        }

        try {
            isApplying = true;
            btn.classList.add('btn-loading');
            btn.textContent = '应用中...';
            
            await new Promise(resolve => {
                vscode.postMessage({ type: 'applyConfig' });
                setTimeout(resolve, 500);
            });
        } finally {
            isApplying = false;
            btn.classList.remove('btn-loading');
            btn.textContent = '应用配置';
        }
    });
    // 更新时间显示
function updateSystemTime() {
    const now = new Date();
    const timeElement = document.getElementById('currentTime');
    const dateElement = document.getElementById('currentDate');
    const weekElement = document.getElementById('weekDay');

    // 请求农历数据
    vscode.postMessage({
        type: 'getLunarDate',
        date: now.toISOString()
    });

    // 完整阳历日期显示
    dateElement.textContent = now.toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });

    // 完整星期显示
    const weekDays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    weekElement.textContent = weekDays[now.getDay()];

    // 精确到秒的时间显示
    timeElement.textContent = now.toLocaleTimeString('zh-CN', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

        // 初始化时钟
        updateSystemTime();
        const clockInterval = setInterval(updateSystemTime, 1000);

        // 获取日出日落时间（需在extension.ts中添加API处理）
function getSunTimes() {
    vscode.postMessage({
        type: 'getSunTimes',
        date: new Date().toISOString().split('T')[0]
    });
}

// 初始化时获取日出时间
getSunTimes();
setInterval(getSunTimes, 3600000); // 每小时更新一次

// 天气代码映射表
const weatherCodes = {
    0: { icon: '☀️', desc: '晴' },
    1: { icon: '🌤️', desc: '晴' },
    2: { icon: '⛅', desc: '多云' },
    3: { icon: '☁️', desc: '阴' },
    45: { icon: '🌫️', desc: '雾' },
    61: { icon: '🌧️', desc: '小雨' },
    80: { icon: '🌦️', desc: '阵雨' },
    95: { icon: '⛈️', desc: '雷阵雨' },
    96: { icon: '🌨️', desc: '雨夹雪' }
};

// 初始化天气请求
function getWeather() {
    vscode.postMessage({ type: 'getWeather' });
}
getWeather();
setInterval(getWeather, 3600000); // 每小时更新

// 处理天气数据
window.addEventListener('message', event => {
    if (event.data.type === 'weatherUpdate') {
    const codeData = weatherCodes[event.data.code] || { icon: '🌈', desc: '未知' };
        document.getElementById('weatherIcon').textContent = codeData.icon;
        document.getElementById('weatherTemp').textContent = event.data.temp+"°C";
        document.getElementById('weatherWind').textContent = event.data.wind+"km/h";
        document.querySelectorAll('.tooltip').forEach(tooltip => {
            if(tooltip.parentElement.querySelector('#weatherIcon')) {
                tooltip.textContent = codeData.desc; // 天气描述
            } else {
                // 风速分级描述
                const windLevel = event.data.wind >= 20 ? '强风' : 
                                event.data.wind >= 10 ? '清风' : '微风';
                tooltip.textContent = windLevel+event.data.wind+"km/h";
            }
        });
    }
});

        // 监听模式切换事件
        document.getElementById('modeSelect').addEventListener('change', function() {
            document.getElementById('timeDisplay').style.display = 
                this.value === 'auto' ? 'block' : 'none';
        });

        // 监听日出时间返回
window.addEventListener('message', event => {
    if (event.data.type === 'sunTimes') {
        document.getElementById('sunriseTime').textContent = event.data.sunrise;
        document.getElementById('sunsetTime').textContent = event.data.sunset;
    }
});

        // 清理定时器（可选）
        window.addEventListener('beforeunload', () => {
            clearInterval(clockInterval);
        });

// 处理农历数据返回
window.addEventListener('message', event => {
    if (event.data.type === 'lunarDate') {
        const lunar = event.data.data;
       document.getElementById('lunarDate').textContent =lunar.year+"年"+lunar.month+lunar.day;
    }
});

// 在初始化时获取当前主题
let currentTheme = "";
vscode.postMessage({
    type: 'getCurrentTheme' 
});

// 新增消息监听
window.addEventListener('message', event => {
    if (event.data.type === 'currentTheme') {
        currentTheme = event.data.theme;
        // 当同时收到主题列表时处理选中状态
        if (event.data.themes) {
            populateThemes(event.data.themes);
        }
    }
});

// 初始化主题选择器
function initThemeSelectors() {
    vscode.postMessage({
        type: 'getAllThemes' // 需要扩展程序添加对应消息处理
    });
}

// 监听主题数据返回
window.addEventListener('message', event => {
    if (event.data.type === 'themeList') {
        populateThemes(event.data.themes);
    }
});

// 填充主题数据
function populateThemes(themes) {
    const dayThemes = themes.filter(t => t.uiTheme === 'vs');
    const nightThemes = themes.filter(t => t.uiTheme === 'vs-dark');

    // 填充白天主题
    dayThemes.forEach(theme => {
        const option = new Option(theme.label, theme.themeId);
        option.selected = currentConfig.daytime.theme === theme.themeId;
        document.getElementById('dayThemes').appendChild(option);
    });

    // 填充夜间主题
    nightThemes.forEach(theme => {
        const option = new Option(theme.label, theme.themeId);
        option.selected = currentConfig.nighttime.theme === theme.themeId;
        document.getElementById('nightThemes').appendChild(option);
    });
}

// 在初始化时调用
initThemeSelectors();

// 初始化时获取定位
vscode.postMessage({ type: 'getLocation' });

// 处理定位数据
window.addEventListener('message', event => {
    if (event.data.type === 'locationUpdate') {
        document.getElementById('ipAddress').textContent = event.data.ip;
        document.getElementById('geoLocation').textContent = event.data.location;
        document.getElementById('geoCoordinates').textContent = event.data.coordinates;
    }
});

// 添加定时更新（每30分钟）
setInterval(() => {
    vscode.postMessage({ type: 'getLocation' });
}, 1800000);
</script>
    </body>
    </html>`;
}

// 获取所有颜色主题的信息
function getAllColorThemes(): ThemeInfo[] {
    return vscode.extensions.all
        .flatMap(
            (ext) =>
                ext.packageJSON?.contributes?.themes?.map((theme: any) => ({
                    label: theme.label || "未命名主题",
                    themeId: theme.id || theme.label,
                    uiTheme: theme.uiTheme || "vs",
                    extensionId: ext.id,
                    path: theme.path ? vscode.Uri.joinPath(ext.extensionUri, theme.path).fsPath : undefined,
                })) || []
        )
        .filter((theme) => theme.uiTheme !== "hc"); // 过滤高对比度主题
}

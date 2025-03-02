import * as assert from "assert";
import * as vscode from "vscode";
import * as sinon from "sinon";
import { activate } from "../extension";

// 模拟VS Code工作区配置
const mockConfig = (values: any) =>
    ({
        get: (key: string) => values[key],
        has: sinon.stub().returns(true),
        inspect: sinon.stub().returns({ key: "", defaultValue: null }),
        update: sinon.stub().resolves(),
    } as unknown as vscode.WorkspaceConfiguration);

describe("Extension Test Suite", () => {
    let context: vscode.ExtensionContext;
    let sandbox: sinon.SinonSandbox;

    before(() => {
        sandbox = sinon.createSandbox();
        context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    });

    afterEach(() => {
        sandbox.restore();
    });

    test("扩展激活时应注册Webview视图", () => {
        activate(context);
        assert.ok(context.subscriptions.length > 0, "应注册至少一个订阅");
    });

    describe("配置管理", () => {
        test("应加载默认配置", async () => {
            const config = mockConfig({});
            sandbox.stub(vscode.workspace, "getConfiguration").returns(config);

            await activate(context);
            assert.deepStrictEqual(config.get("autoTheme.mode"), "auto");
        });

        test("应正确覆盖自定义配置", async () => {
            const customConfig = {
                mode: "manual",
                latitude: 31.2304,
                longitude: 121.4737,
            };
            const config = mockConfig(customConfig);
            sandbox.stub(vscode.workspace, "getConfiguration").returns(config);

            await activate(context);
            assert.strictEqual(config.get("autoTheme.mode"), "manual");
        });
    });

    describe("主题切换逻辑", () => {
        let clock: sinon.SinonFakeTimers;

        afterEach(() => {
            clock?.restore();
        });

        test("自动模式应根据时间切换主题", async () => {
            clock = sinon.useFakeTimers(new Date("2024-06-01T12:00:00").getTime());
            const config = mockConfig({
                mode: "auto",
                daytime: { start: "06:00", end: "18:00", theme: "Light" },
                nighttime: { start: "18:00", end: "06:00", theme: "Dark" },
            });
            sandbox.stub(vscode.workspace, "getConfiguration").returns(config);
            const updateStub = config.update as sinon.SinonStub;

            await activate(context);
            assert.ok(updateStub.calledWith("workbench.colorTheme", "Light"));
        });

        test("手动模式应遵循用户设置", async () => {
            const config = mockConfig({
                mode: "manual",
                currentTheme: "Custom Theme",
            });
            sandbox.stub(vscode.workspace, "getConfiguration").returns(config);
            const updateStub = config.update as sinon.SinonStub;

            await activate(context);
            assert.ok(updateStub.calledWith("workbench.colorTheme", "Custom Theme"));
        });
    });

    describe("定位服务", () => {
        test("应优先使用ipapi.co服务", async () => {
            const fetchStub = sandbox.stub(global, "fetch");
            fetchStub.withArgs("https://ipapi.co/json/").resolves({
                ok: true,
                json: () =>
                    Promise.resolve({
                        latitude: 31.2304,
                        longitude: 121.4737,
                    }),
            } as Response);

            await activate(context);
            assert.ok(fetchStub.calledWith("https://ipapi.co/json/"));
        });

        test("主服务失败时应回退到ip.sb", async () => {
            const fetchStub = sandbox.stub(global, "fetch");
            fetchStub.withArgs("https://ipapi.co/json/").rejects(new Error("Timeout"));
            fetchStub.withArgs("https://api.ip.sb/geoip").resolves({
                ok: true,
                json: () =>
                    Promise.resolve({
                        latitude: 39.9042,
                        longitude: 116.4074,
                    }),
            } as Response);

            await activate(context);
            assert.ok(fetchStub.calledWith("https://api.ip.sb/geoip"));
        });
    });

    describe("日出日落计算", () => {
        test("应正确处理API响应", async () => {
            const fakeResponse = {
                status: "OK",
                results: {
                    sunrise: "2024-06-01T04:51:00+00:00",
                    sunset: "2024-06-01T18:52:00+00:00",
                },
            };
            sandbox.stub(global, "fetch").resolves({
                json: () => Promise.resolve(fakeResponse),
            } as Response);

            await activate(context);
            // 验证是否更新了配置中的时间
            const config = vscode.workspace.getConfiguration();
            assert.strictEqual(config.get("autoTheme.daytime.start"), "04:51");
        });
    });

    describe("错误处理", () => {
        test("应处理无效的定位数据", async () => {
            sandbox.stub(global, "fetch").resolves({
                json: () => Promise.resolve({ latitude: null }),
            } as Response);
            const showWarning = sandbox.stub(vscode.window, "showWarningMessage");

            await activate(context);
            assert.ok(showWarning.calledWithMatch("自动定位失败"));
        });

        test("应处理网络请求失败", async () => {
            sandbox.stub(global, "fetch").rejects(new Error("Network error"));
            const showError = sandbox.stub(vscode.window, "showErrorMessage");

            await activate(context);
            assert.ok(showError.calledWithMatch("获取定位失败"));
        });
    });
});

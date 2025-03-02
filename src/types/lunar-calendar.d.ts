declare module "lunar-calendar" {
    export function solarToLunar(
        y: number,
        m: number,
        d: number
    ): {
        lunarYear: number;
        lunarMonth: number;
        lunarDay: number;
        lunarMonthName: string;
        lunarDayName: string;
    };
}

// PWM
/*
    功能介绍:
    1. 根据系统时钟产生固定频率的PWM波形。
    2. 通过 duty 参数控制PWM占空比。
    3. 支持PWM使能控制，关闭时输出低电平。
    4. duty在PWM周期起始位置更新，避免占空比变化时产生毛刺。
    5. 该模块为通用PWM模块，不包含具体电机控制逻辑，
       可用于电机、LED、舵机等需要PWM输出的场景。

    输入:
        clk     : 系统时钟
        rst_n   : 低电平复位
        pwm_en  : PWM输出使能
        duty    : PWM比较值/占空比控制值

    输出:
        pwm_out : PWM波形输出

    参数:
        CLK_FREQ_HZ : 系统时钟频率
        PWM_FREQ_HZ : PWM目标频率
        PWM_WIDTH   : PWM计数器及duty数据位宽

    占空比关系:
        PERIOD_TICKS = CLK_FREQ_HZ / PWM_FREQ_HZ

        Duty = duty / PERIOD_TICKS

        duty = 0
            -> 0%

        duty = PERIOD_TICKS / 2
            -> 50%

        duty >= PERIOD_TICKS
            -> 100%

    示例:
        CLK_FREQ_HZ = 50_000_000
        PWM_FREQ_HZ = 20_000

        PERIOD_TICKS = 2500

        duty = 1250
            -> PWM占空比约为50%
*/
module pwm_gen #(
    parameter integer CLK_FREQ_HZ = 50_000_000,
    parameter integer PWM_FREQ_HZ = 20_000,
    parameter integer PWM_WIDTH   = 16
)(
    input  wire                     clk,
    input  wire                     rst_n,

    input  wire                     pwm_en,

    // 0 ~ PERIOD_TICKS
    input  wire [PWM_WIDTH-1:0]     duty,

    output reg                      pwm_out
);

    // ==============================
    // PWM周期计数值
    // ==============================

    localparam integer PERIOD_TICKS =
        CLK_FREQ_HZ / PWM_FREQ_HZ;


    // ==============================
    // PWM计数器
    // ==============================

    reg [PWM_WIDTH-1:0] pwm_cnt;


    // ==============================
    // 占空比锁存值
    // ==============================
    // duty只在一个新的PWM周期开始时更新
    // 防止运行过程中修改duty产生毛刺

    reg [PWM_WIDTH-1:0] duty_active;


    // ==============================
    // PWM计数
    // ==============================

    always @(posedge clk)
    begin

        if (!rst_n)
        begin
            pwm_cnt     <= 0;
            duty_active <= 0;
        end

        else if (!pwm_en)
        begin
            pwm_cnt     <= 0;
            duty_active <= 0;
        end

        else
        begin

            // 每个PWM周期开始时更新CCR
            if (pwm_cnt == 0)
            begin
                duty_active <= duty;
            end


            // ARR计数
            if (pwm_cnt >= PERIOD_TICKS - 1)
            begin
                pwm_cnt <= 0;
            end

            else
            begin
                pwm_cnt <= pwm_cnt + 1'b1;
            end

        end

    end


    // ==============================
    // PWM输出
    // ==============================

    always @(*)
    begin

        if (!pwm_en)
        begin
            pwm_out = 1'b0;
        end

        // 0%
        else if (duty_active == 0)
        begin
            pwm_out = 1'b0;
        end

        // 100%
        else if (duty_active >= PERIOD_TICKS)
        begin
            pwm_out = 1'b1;
        end

        // 正常PWM
        else if (pwm_cnt < duty_active)
        begin
            pwm_out = 1'b1;
        end

        else
        begin
            pwm_out = 1'b0;
        end

    end

endmodule
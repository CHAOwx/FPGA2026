// TB6612 Motor Driver
/*
    功能介绍:
    1. 驱动TB6612单路直流电机。
    2. 使用有符号motor_pwm同时表达电机方向与PWM大小。
    3. motor_pwm > 0 : 电机正方向运行。
    4. motor_pwm < 0 : 电机反方向运行。
    5. motor_pwm = 0 : 电机停止。
    6. motor_brake = 1 : 电机主动刹车。
    7. motor_en = 0 : 禁止电机输出。
    8. DIR_REVERSE用于配置电机物理安装方向，
       使得上层控制无需关心IN1/IN2实际方向。
    9. 内部调用通用PWM模块产生PWM波形。

    注意:
    STBY已经在PCB上直接连接3V3，
    因此本模块不负责STBY控制。

    motor_pwm范围:
        -PERIOD_TICKS ~ +PERIOD_TICKS

    例如:
        CLK = 50MHz
        PWM = 20kHz

        PERIOD_TICKS = 2500

        motor_pwm = +1250
            -> 正方向 50%

        motor_pwm = -1250
            -> 反方向 50%

        motor_pwm = 0
            -> 停止
*/

module TB6612_Motor_driver #(
    parameter integer CLK_FREQ_HZ = 50_000_000,
    parameter integer PWM_FREQ_HZ = 20_000,
    parameter integer PWM_WIDTH   = 16,

    // 0:
    // 正方向 -> IN1=1, IN2=0
    //
    // 1:
    // 正方向 -> IN1=0, IN2=1
    parameter integer DIR_REVERSE = 0

)(
    input  wire                         clk,
    input  wire                         rst_n,

    // 电机逻辑总使能
    input  wire                         motor_en,

    // 主动刹车
    input  wire                         motor_brake,

    // 有符号电机控制量
    input  wire signed [PWM_WIDTH-1:0]  motor_pwm,

    // TB6612输出
    output reg                          tb_in1,
    output reg                          tb_in2,
    output reg                          tb_pwm
);


// ============================================================
// PWM周期
// ============================================================

localparam integer PERIOD_TICKS =
    CLK_FREQ_HZ / PWM_FREQ_HZ;


// ============================================================
// 判断方向
// ============================================================

// 1 = motor_pwm为负数
wire motor_negative;

assign motor_negative = (motor_pwm < 0);


// ============================================================
// 计算绝对值
// ============================================================

wire [PWM_WIDTH-1:0] motor_pwm_abs;

assign motor_pwm_abs =
    motor_negative ? -motor_pwm : motor_pwm;


// ============================================================
// PWM限幅
// ============================================================

wire [PWM_WIDTH-1:0] pwm_duty;

assign pwm_duty =
    (motor_pwm_abs >= PERIOD_TICKS) ?
    PERIOD_TICKS :
    motor_pwm_abs;


// ============================================================
// PWM使能
// ============================================================

wire pwm_enable;

assign pwm_enable =
    motor_en &&
    !motor_brake &&
    (motor_pwm != 0);


// ============================================================
// PWM模块
// ============================================================

wire pwm_raw;


pwm_gen #(
    .CLK_FREQ_HZ (CLK_FREQ_HZ),
    .PWM_FREQ_HZ (PWM_FREQ_HZ),
    .PWM_WIDTH   (PWM_WIDTH)
)
u_pwm_gen
(
    .clk        (clk),
    .rst_n      (rst_n),

    .pwm_en     (pwm_enable),

    .duty       (pwm_duty),

    .pwm_out    (pwm_raw)
);


// ============================================================
// 实际方向
// ============================================================
//
// DIR_REVERSE = 0:
//
// motor_pwm > 0
//     IN1 = 1
//     IN2 = 0
//
// motor_pwm < 0
//     IN1 = 0
//     IN2 = 1
//
//
// DIR_REVERSE = 1:
//
// 上述方向全部交换
//
// ============================================================

wire physical_reverse;

assign physical_reverse =
    motor_negative ^ DIR_REVERSE;


// ============================================================
// TB6612输出逻辑
// ============================================================

always @(*)
begin

    // 默认停止
    tb_in1 = 1'b0;
    tb_in2 = 1'b0;
    tb_pwm = 1'b0;


    // ========================================================
    // 未使能
    // ========================================================

    if (!motor_en)
    begin

        tb_in1 = 1'b0;
        tb_in2 = 1'b0;
        tb_pwm = 1'b0;

    end


    // ========================================================
    // 主动刹车
    // ========================================================

    else if (motor_brake)
    begin

        tb_in1 = 1'b1;
        tb_in2 = 1'b1;
        tb_pwm = 1'b1;

    end


    // ========================================================
    // 输出为0
    // ========================================================

    else if (motor_pwm == 0)
    begin

        tb_in1 = 1'b0;
        tb_in2 = 1'b0;
        tb_pwm = 1'b0;

    end


    // ========================================================
    // 电机运行
    // ========================================================

    else
    begin

        // 正物理方向
        if (!physical_reverse)
        begin

            tb_in1 = 1'b1;
            tb_in2 = 1'b0;

        end

        // 反物理方向
        else
        begin

            tb_in1 = 1'b0;
            tb_in2 = 1'b1;

        end


        tb_pwm = pwm_raw;

    end

end


endmodule
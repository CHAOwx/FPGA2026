// 自动启摆倒立摆：50MHz/rst_n低有效，上电停止；角度中心2060、ADC CH0可由参数修改。
// K1/K2按下目标位置+/-34(408/4/3)，限幅+/-4080；K3按下自动启摆/停止；K4未使用。
// 数码管左4位状态(0/1/21~24/31~34/4)，右4位|位置|；K3启动前记录零点，捕获时保留。
// 1ms采样/保护，40ms启摆判断，5ms角度PID，50ms位置PID；35%双向脉冲各100ms。
// UART 115200/8N1 Protocol V1：输出两环goal/real/set及Kp/Ki/Kd共12项，每20ms一帧。
// 仅接收角度Kp/Ki/Kd(ID10/11/12)、位置Kp/Ki/Kd(ID20/21/22)，Q16.16；无其他串口控制。
// 两个原版PID_Core独立例化，目标/反馈/输出为整数；系数为Q16.16。
// 采样寄存在控制层，下一拍触发PID；串口a_goal/a_set/p_set按Q16.16编码整数值。
`timescale 1ns / 1ps
module Test #(
    parameter integer ENCODER_DIR_REVERSE = 0,
    parameter integer MOTOR_DIR_REVERSE = 1,
    parameter [2:0] ADC_CHANNEL = 3'd0,
    parameter integer CENTER_ANGLE = 2060,
    parameter integer CENTER_RANGE = 500,
    parameter integer START_PWM = 35,
    parameter integer START_TIME = 100,
    parameter signed [31:0] A_KP_INIT = 32'sd19661, // 0.3
    parameter signed [31:0] A_KI_INIT = 32'sd655,   // 0.01
    parameter signed [31:0] A_KD_INIT = 32'sd26214, // 0.4
    parameter signed [31:0] P_KP_INIT = 32'sd26214, // 0.4
    parameter signed [31:0] P_KI_INIT = 32'sd1049, // 0.016
    parameter signed [31:0] P_KD_INIT = 32'sd262144,// 4
    parameter signed [31:0] I_LIMIT = 32'sd100
)(
    input wire clk,
    input wire rst_n,
    input wire [3:0] key_in,
    input wire encoder_a,
    input wire encoder_b,
    input wire uart_rx,
    output wire uart_tx,
    input wire ADC_DOUT,
    output wire ADC_SCLK,
    output wire ADC_DIN,
    output wire ADC_CS_N,
    output wire tb_in1,
    output wire tb_in2,
    output wire tb_pwm,
    output wire ds,
    output wire sh_cp,
    output wire st_cp
    );
    localparam signed [31:0] CENTER_Q = CENTER_ANGLE * 65536;
    reg [15:0] ms_counter;
    wire ms_tick = (ms_counter == 16'd49999);
    reg [5:0] run_state;
    reg [5:0] judge_count, position_count;
    reg [2:0] angle_count;
    reg [15:0] kick_time;
    reg [1:0] history_count;
    reg [11:0] angle0, angle1, angle_sample;
    reg signed [31:0] target_position, position_offset, position_sample, swing_pwm;
    reg signed [31:0] angle_goal_sample, position_goal_sample;
    reg capture_clear, position_capture_clear;
    wire [2:0] key_press;
    wire [11:0] adc_data;
    wire adc_valid;
    reg adc_ready;
    reg [2:0] adc_age;
    wire sensor_ok = adc_ready && (adc_age < 3);
    wire in_center = (adc_data > CENTER_ANGLE - CENTER_RANGE) &&
                     (adc_data < CENTER_ANGLE + CENTER_RANGE);
    wire balance_en = (run_state == 4) && sensor_ok && in_center && !key_press[2];
    wire angle_due = ms_tick && balance_en && (angle_count == 4);
    wire position_due = ms_tick && balance_en && (position_count == 49);
    reg angle_tick, position_tick;
    wire signed [31:0] position_cnt;
    wire signed [32:0] relative_position = {position_cnt[31], position_cnt} -
                                          {position_offset[31], position_offset};
    wire signed [31:0] position_feedback = (relative_position > 33'sd2147483647) ? 32'sh7fffffff :
                                          (relative_position < -33'sd2147483648) ? 32'sh80000000 :
                                          relative_position[31:0];
    wire signed [31:0] a_kp, a_ki, a_kd, p_kp, p_ki, p_kd;
    wire signed [31:0] a_out, p_out;
    wire a_valid, p_valid, a_update, p_update;
    wire signed [31:0] a_goal = CENTER_ANGLE - (balance_en ? p_out : 32'sd0);
    wire signed [31:0] a_feedback = {20'b0, angle_sample};
    wire signed [31:0] a_set = balance_en ? a_out : 32'sd0;
    wire signed [31:0] p_set = balance_en ? p_out : 32'sd0;
    wire motor_en = rst_n && sensor_ok && (run_state != 0) &&
                    ((run_state != 4) || in_center) && !key_press[2];
    wire signed [31:0] motor_percent = !motor_en ? 32'sd0 :
                                     (run_state == 4) ? a_out : swing_pwm;
    // 电机百分比 -> 20kHz/2500计数，单位换算属于控制层。
    wire signed [31:0] motor_scaled = motor_percent * 32'sd25;
    wire signed [15:0] PWM = motor_scaled[15:0];
    wire [31:0] count_abs = position_sample[31] ? -position_sample : position_sample;
    wire [31:0] Data = run_state * 32'd10000 + count_abs % 32'd10000;
    wire set_valid;
    wire [7:0] set_param_id, set_param_type;
    wire [31:0] set_param_value;
    wire tx_busy;
    wire [7:0] param_index, param_count, param_id, param_type;
    wire [31:0] param_value;
    reg [4:0] telemetry_count;
    reg send_en;
    reg signed [31:0] frame_a_goal, frame_a_real, frame_a_set;
    reg signed [31:0] frame_p_goal, frame_p_real, frame_p_set;
    reg signed [31:0] frame_a_kp, frame_a_ki, frame_a_kd, frame_p_kp, frame_p_ki, frame_p_kd;

    adc128s102 #(.CHANNEL(ADC_CHANNEL), .SCLK_DIV(2))
        adc_inst (
            .clk(clk),
            .rst_n(rst_n),
            .ADC_DOUT(ADC_DOUT),
            .ADC_SCLK(ADC_SCLK),
            .ADC_DIN(ADC_DIN),
            .ADC_CS_N(ADC_CS_N),
            .data(adc_data),
            .data_valid(adc_valid)
        );

    genvar i;
    generate
        for (i = 0; i < 3; i = i + 1) begin : gen_keys
            key
                key_inst (
                    .clk(clk),
                    .rst_n(rst_n),
                    .key_in(key_in[i]),
                    .key_state(),
                    .key_press(key_press[i]),
                    .key_release(),
                    .key_change()
                );
        end
    endgenerate

    // 所有定时均为单周期使能，控制逻辑只使用50MHz系统时钟。
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            ms_counter <= 0;
            adc_ready <= 0;
            adc_age <= 0;
            angle_sample <= 0;
            position_sample <= 0;
            angle_goal_sample <= CENTER_ANGLE;
            position_goal_sample <= 0;
            angle_tick <= 0; position_tick <= 0;
            position_capture_clear <= 0;
        end else begin
            ms_counter <= ms_tick ? 16'd0 : ms_counter + 1'b1;
            // 先采样，再把独立tick交给两个原版PID；不改PID内部数据通路。
            angle_tick <= angle_due;
            position_tick <= position_due;
            // 捕获时保留启动零点的实际位置，下一拍通过原接口清外环历史误差。
            position_capture_clear <= capture_clear;
            if (adc_valid) begin
                adc_ready <= 1;
                adc_age <= 0;
            end else if (ms_tick && adc_age != 7) adc_age <= adc_age + 1'b1;
            if (ms_tick) begin
                angle_sample <= adc_data;
                angle_goal_sample <= a_goal;
                position_goal_sample <= target_position;
                position_sample <= (relative_position > 33'sd2147483647) ? 32'sh7fffffff :
                                   (relative_position < -33'sd2147483648) ? 32'sh80000000 :
                                   relative_position[31:0];
            end
        end
    end

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            run_state <= 0;
            target_position <= 0;
            position_offset <= 0;
            swing_pwm <= 0;
            judge_count <= 0; angle_count <= 0; position_count <= 0;
            kick_time <= 0; history_count <= 0; angle0 <= 0; angle1 <= 0;
            capture_clear <= 0;
        end else begin
            capture_clear <= 0;
            case (key_press[1:0])
                2'b01: target_position <= (target_position >= 4046) ? 32'sd4080 : target_position + 32'sd34;
                2'b10: target_position <= (target_position <= -4046) ? -32'sd4080 : target_position - 32'sd34;
                default: ;
            endcase
            // 停止按键优先；仅在K3启动前记录位置零点，捕获时不改目标或坐标。
            if (key_press[2] || !sensor_ok) begin
                run_state <= (key_press[2] && run_state == 0 && sensor_ok) ? 6'd21 : 6'd0;
                if (key_press[2] && run_state == 0 && sensor_ok) position_offset <= position_cnt;
                swing_pwm <= 0;
                judge_count <= 0; angle_count <= 0; position_count <= 0;
                kick_time <= 0; history_count <= 0;
            end else if (ms_tick) begin
                case (run_state)
                    0: swing_pwm <= 0;
                    1: begin
                        if (judge_count == 39) begin
                            judge_count <= 0;
                            angle1 <= angle0;
                            angle0 <= adc_data;
                            if (history_count < 2) history_count <= history_count + 1'b1;
                            if (history_count >= 2 && adc_data > CENTER_ANGLE + CENTER_RANGE &&
                                angle0 > CENTER_ANGLE + CENTER_RANGE && angle1 > CENTER_ANGLE + CENTER_RANGE &&
                                angle0 < adc_data && angle0 < angle1) run_state <= 21;
                            if (history_count >= 2 && adc_data < CENTER_ANGLE - CENTER_RANGE &&
                                angle0 < CENTER_ANGLE - CENTER_RANGE && angle1 < CENTER_ANGLE - CENTER_RANGE &&
                                angle0 > adc_data && angle0 > angle1) run_state <= 31;
                            if (history_count >= 1 && in_center && angle0 > CENTER_ANGLE - CENTER_RANGE &&
                                angle0 < CENTER_ANGLE + CENTER_RANGE) begin
                                capture_clear <= 1;
                                angle_count <= 0; position_count <= 0;
                                run_state <= 4;
                            end
                        end else judge_count <= judge_count + 1'b1;
                    end
                    21, 31: begin
                        swing_pwm <= (run_state == 21) ? START_PWM : -START_PWM;
                        kick_time <= START_TIME;
                        run_state <= (run_state == 21) ? 6'd22 : 6'd32;
                    end
                    22, 32: begin
                        kick_time <= kick_time - 1'b1;
                        if (kick_time == 1) run_state <= (run_state == 22) ? 6'd23 : 6'd33;
                    end
                    23, 33: begin
                        swing_pwm <= (run_state == 23) ? -START_PWM : START_PWM;
                        kick_time <= START_TIME;
                        run_state <= (run_state == 23) ? 6'd24 : 6'd34;
                    end
                    24, 34: begin
                        kick_time <= kick_time - 1'b1;
                        if (kick_time == 1) begin
                            swing_pwm <= 0;
                            judge_count <= 0; history_count <= 0;
                            run_state <= 1;
                        end
                    end
                    4: begin
                        if (!in_center) begin
                            run_state <= 0;
                            angle_count <= 0; position_count <= 0;
                        end else begin
                            angle_count <= (angle_count == 4) ? 3'd0 : angle_count + 1'b1;
                            position_count <= (position_count == 49) ? 6'd0 : position_count + 1'b1;
                        end
                    end
                    default: begin run_state <= 0; swing_pwm <= 0; end
                endcase
            end
        end
    end

    protocol_rx
        protocol_rx_inst (
            .clk(clk),
            .rst_n(rst_n),
            .uart_rx(uart_rx),
            .baud_set(3'd4),
            .set_valid(set_valid),
            .set_param_id(set_param_id),
            .set_param_type(set_param_type),
            .set_param_value(set_param_value),
            .crc_error(),
            .format_error(),
            .last_seq()
        );

    parameter_manager #(.KP_INIT(A_KP_INIT), .KI_INIT(A_KI_INIT), .KD_INIT(A_KD_INIT))
        angle_parameters (
            .clk(clk),
            .rst_n(rst_n),
            .set_valid(set_valid && set_param_id[7:4] != 4'h2),
            .set_param_id(set_param_id),
            .set_param_type(set_param_type),
            .set_param_value(set_param_value),
            .kp(a_kp),
            .ki(a_ki),
            .kd(a_kd),
            .update_done(a_update),
            .type_error(),
            .id_error()
        );

    parameter_manager #(.KP_INIT(P_KP_INIT), .KI_INIT(P_KI_INIT), .KD_INIT(P_KD_INIT), .ID_KP(8'h20), .ID_KI(8'h21), .ID_KD(8'h22))
        position_parameters (
            .clk(clk),
            .rst_n(rst_n),
            .set_valid(set_valid && set_param_id[7:4] == 4'h2),
            .set_param_id(set_param_id),
            .set_param_type(set_param_type),
            .set_param_value(set_param_value),
            .kp(p_kp),
            .ki(p_ki),
            .kd(p_kd),
            .update_done(p_update),
            .type_error(),
            .id_error()
        );

    PID_Core
        angle_pid (
            .clk(clk),
            .rst_n(rst_n),
            .pid_en(balance_en),
            .pid_clear(capture_clear || a_update),
            .pid_tick(angle_tick),
            .target(angle_goal_sample),
            .feedback(a_feedback),
            .kp_q(a_kp),
            .ki_q(a_ki),
            .kd_q(a_kd),
            .out_max(32'sd100),
            .out_min(-32'sd100),
            .i_limit(I_LIMIT),
            .pid_out(a_out),
            .error_out(),
            .p_out(),
            .i_out(),
            .d_out(),
            .pid_valid(a_valid)
        );

    PID_Core
        position_pid (
            .clk(clk),
            .rst_n(rst_n),
            .pid_en(balance_en),
            .pid_clear(position_capture_clear || p_update),
            .pid_tick(position_tick),
            .target(position_goal_sample),
            .feedback(position_sample),
            .kp_q(p_kp),
            .ki_q(p_ki),
            .kd_q(p_kd),
            .out_max(32'sd100),
            .out_min(-32'sd100),
            .i_limit(I_LIMIT),
            .pid_out(p_out),
            .error_out(),
            .p_out(),
            .i_out(),
            .d_out(),
            .pid_valid(p_valid)
        );

    // 不论停止/启摆/稳摆均上传实测值；发送期间十二个字段冻结。
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            telemetry_count <= 0; send_en <= 0;
            frame_a_goal <= CENTER_Q; frame_a_real <= 0; frame_a_set <= 0;
            frame_p_goal <= 0; frame_p_real <= 0; frame_p_set <= 0;
            frame_a_kp <= A_KP_INIT; frame_a_ki <= A_KI_INIT; frame_a_kd <= A_KD_INIT;
            frame_p_kp <= P_KP_INIT; frame_p_ki <= P_KI_INIT; frame_p_kd <= P_KD_INIT;
        end else begin
            send_en <= 0;
            if (ms_tick) begin
                telemetry_count <= (telemetry_count == 19) ? 5'd0 : telemetry_count + 1'b1;
                if (telemetry_count == 19 && !tx_busy && !send_en) begin
                    frame_a_goal <= a_goal <<< 16; frame_a_real <= {20'b0, adc_data}; frame_a_set <= a_set <<< 16;
                    frame_p_goal <= target_position; frame_p_real <= position_feedback; frame_p_set <= p_set <<< 16;
                    frame_a_kp <= a_kp; frame_a_ki <= a_ki; frame_a_kd <= a_kd;
                    frame_p_kp <= p_kp; frame_p_ki <= p_ki; frame_p_kd <= p_kd;
                    send_en <= 1;
                end
            end
        end
    end

    telemetry_param_mux
        telemetry_param_mux_inst (
            .param_index(param_index),
            .a_goal(frame_a_goal),
            .a_real(frame_a_real),
            .a_set(frame_a_set),
            .p_goal(frame_p_goal),
            .p_real(frame_p_real),
            .p_set(frame_p_set),
            .a_kp(frame_a_kp),
            .a_ki(frame_a_ki),
            .a_kd(frame_a_kd),
            .p_kp(frame_p_kp),
            .p_ki(frame_p_ki),
            .p_kd(frame_p_kd),
            .param_count(param_count),
            .param_id(param_id),
            .param_type(param_type),
            .param_value(param_value)
        );

    protocol_tx
        protocol_tx_inst (
            .clk(clk),
            .rst_n(rst_n),
            .send_en(send_en),
            .baud_set(3'd4),
            .param_count(param_count),
            .param_index(param_index),
            .param_id(param_id),
            .param_type(param_type),
            .param_value(param_value),
            .uart_tx(uart_tx),
            .tx_busy(tx_busy),
            .tx_done()
        );

    TB6612_Motor_driver #(.DIR_REVERSE(MOTOR_DIR_REVERSE))
        TB6612_Motor_driver_inst (
            .clk(clk),
            .rst_n(rst_n),
            .motor_en(motor_en),
            .motor_brake(1'b0),
            .motor_pwm(PWM),
            .tb_in1(tb_in1),
            .tb_in2(tb_in2),
            .tb_pwm(tb_pwm)
        );

    encoder_quad #(.DIR_REVERSE(ENCODER_DIR_REVERSE))
        encoder_quad_inst (
            .clk(clk),
            .rst_n(rst_n),
            .encoder_a(encoder_a),
            .encoder_b(encoder_b),
            .position_zero(1'b0),
            .position_cnt(position_cnt)
        );

    Seg8 #(.DECIMAL_SPLIT(1))
        Seg8_inst (
            .clk(clk),
            .reset_n(rst_n),
            .data(Data),
            .format(2'd1),
            .ds(ds),
            .sh_cp(sh_cp),
            .st_cp(st_cp)
        );
endmodule

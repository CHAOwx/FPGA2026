`timescale 1ns / 1ps
// 上传双环goal/real/set及六个PID参数，与parameter_manager的ID保持一致。
module telemetry_param_mux(
    input wire [7:0] param_index,
    input wire signed [31:0] a_goal,
    input wire signed [31:0] a_real,
    input wire signed [31:0] a_set,
    input wire signed [31:0] p_goal,
    input wire signed [31:0] p_real,
    input wire signed [31:0] p_set,
    input wire signed [31:0] a_kp,
    input wire signed [31:0] a_ki,
    input wire signed [31:0] a_kd,
    input wire signed [31:0] p_kp,
    input wire signed [31:0] p_ki,
    input wire signed [31:0] p_kd,
    output wire [7:0] param_count,
    output reg [7:0] param_id,
    output reg [7:0] param_type,
    output reg [31:0] param_value
);
    assign param_count = 8'd12;
    always @(*) begin
        param_id = 0;
        param_type = 0;
        param_value = 0;
        case (param_index)
            0: begin param_id = 8'h01; param_type = 8'h03; param_value = a_goal; end
            1: begin param_id = 8'h02; param_type = 8'h01; param_value = a_real; end
            2: begin param_id = 8'h03; param_type = 8'h03; param_value = a_set; end
            3: begin param_id = 8'h04; param_type = 8'h01; param_value = p_goal; end
            4: begin param_id = 8'h05; param_type = 8'h01; param_value = p_real; end
            5: begin param_id = 8'h06; param_type = 8'h03; param_value = p_set; end
            6: begin param_id = 8'h10; param_type = 8'h03; param_value = a_kp; end
            7: begin param_id = 8'h11; param_type = 8'h03; param_value = a_ki; end
            8: begin param_id = 8'h12; param_type = 8'h03; param_value = a_kd; end
            9: begin param_id = 8'h20; param_type = 8'h03; param_value = p_kp; end
            10: begin param_id = 8'h21; param_type = 8'h03; param_value = p_ki; end
            11: begin param_id = 8'h22; param_type = 8'h03; param_value = p_kd; end
            default: ;
        endcase
    end
endmodule

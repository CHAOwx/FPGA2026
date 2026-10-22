`timescale 1ns / 1ps
// 固定通道连续采样；data_valid为单周期脉冲，data保持最近一次有效结果。
module adc128s102 #(
    parameter [2:0] CHANNEL = 3'd0,
    parameter integer SCLK_DIV = 2 // SCLK = clk / (2*SCLK_DIV)，50MHz时默认12.5MHz
)(
    input wire clk,
    input wire rst_n,
    input wire ADC_DOUT, // ADC芯片的数据输出，接FPGA输入
    output reg ADC_SCLK,
    output reg ADC_DIN, // ADC芯片的数据输入，由FPGA输出
    output reg ADC_CS_N,
    output reg [11:0] data,
    output reg data_valid
);
    localparam integer DIV_WIDTH = (SCLK_DIV > 1) ? $clog2(SCLK_DIV) : 1;
    localparam [1:0] SHIFT = 0, FINISH = 1, GAP = 2;
    wire [15:0] command = {2'b00, CHANNEL, 11'b0};
    reg [DIV_WIDTH-1:0] div_count;
    reg [1:0] state;
    reg [3:0] bit_count;
    reg [11:0] rx_data;
    reg primed, gap_half;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            ADC_SCLK <= 1'b1;
            ADC_DIN <= 1'b0;
            ADC_CS_N <= 1'b1;
            data <= 12'd0;
            data_valid <= 1'b0;
            div_count <= 0;
            state <= GAP;
            bit_count <= 0;
            rx_data <= 0;
            primed <= 1'b0;
            gap_half <= 1'b0;
        end else begin
            data_valid <= 1'b0;
            if (div_count == SCLK_DIV - 1) begin
                div_count <= 0;
                case (state)
                    SHIFT: begin
                        ADC_SCLK <= ~ADC_SCLK;
                        if (ADC_SCLK)
                            ADC_DIN <= command[15-bit_count]; // 下降沿更新命令
                        else begin
                            rx_data <= {rx_data[10:0], ADC_DOUT}; // 上升沿接收，保留低12位
                            if (bit_count == 15) state <= FINISH;
                            else bit_count <= bit_count + 1'b1;
                        end
                    end
                    FINISH: begin
                        ADC_CS_N <= 1'b1;
                        // 本帧命令选择下一帧通道；复位后第一帧不发布。
                        if (primed) begin
                            data <= rx_data;
                            data_valid <= 1'b1;
                        end
                        primed <= 1'b1;
                        gap_half <= 1'b0;
                        state <= GAP;
                    end
                    GAP: begin
                        // 片选保持高电平一个完整SCLK周期，再启动下一帧。
                        gap_half <= ~gap_half;
                        if (gap_half) begin
                            ADC_CS_N <= 1'b0;
                            bit_count <= 0;
                            state <= SHIFT;
                        end
                    end
                    default: begin
                        ADC_CS_N <= 1'b1;
                        ADC_SCLK <= 1'b1;
                        primed <= 1'b0;
                        gap_half <= 1'b0;
                        state <= GAP;
                    end
                endcase
            end else div_count <= div_count + 1'b1;
        end
    end
endmodule

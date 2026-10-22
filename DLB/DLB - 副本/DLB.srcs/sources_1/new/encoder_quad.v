// Quadrature Encoder
/*
    功能介绍:
    1. 接收AB两相正交编码器信号。
    2. 对Encoder A、Encoder B进行双触发器同步。
    3. 使用AB两相状态变化进行四倍频解码。
    4. 正转时position_cnt增加。
    5. 反转时position_cnt减少。
    6. 支持单独清零编码器累计位置。
    7. DIR_REVERSE=0保持原AB方向，=1交换计数正负方向。

    注意:
    该模块只负责编码器计数，
    不负责角度、转速、减速比等计算。

    输入:
        clk          : FPGA系统时钟
        rst_n        : 系统复位，低有效

        encoder_a    : 编码器A相
        encoder_b    : 编码器B相

        position_zero:
            1 -> 将累计位置清零

    输出:
        position_cnt :
            编码器四倍频后的累计位置计数

    参数:
        DIR_REVERSE : 0为原方向，1为反方向；顺/逆时针对应关系由实际AB接线确定。
        position_cnt的正负表示相对零点的位置，当前运动方向应看计数增量。
*/

`timescale 1ns / 1ps
module encoder_quad #(
    parameter integer DIR_REVERSE = 0
)
(
    input  wire                     clk,
    input  wire                     rst_n,

    input  wire                     encoder_a,
    input  wire                     encoder_b,

    input  wire                     position_zero,

    output reg signed [31:0]        position_cnt
);

localparam signed [31:0] COUNT_STEP = (DIR_REVERSE == 0) ? 32'sd1 : -32'sd1;

// ============================================================
// 编码器输入同步
// ============================================================

// 编码器信号来自FPGA时钟域外部
// 必须先进行同步

reg encoder_a_d1;
reg encoder_a_d2;

reg encoder_b_d1;
reg encoder_b_d2;


always @(posedge clk)
begin

    if (!rst_n)
    begin

        encoder_a_d1 <= 1'b0;
        encoder_a_d2 <= 1'b0;

        encoder_b_d1 <= 1'b0;
        encoder_b_d2 <= 1'b0;

    end

    else
    begin

        encoder_a_d1 <= encoder_a;
        encoder_a_d2 <= encoder_a_d1;

        encoder_b_d1 <= encoder_b;
        encoder_b_d2 <= encoder_b_d1;

    end

end


// ============================================================
// AB状态
// ============================================================

wire [1:0] encoder_ab;

assign encoder_ab =
{
    encoder_a_d2,
    encoder_b_d2
};


reg [1:0] encoder_ab_last;


// ============================================================
// AB相四倍频解码
// ============================================================
//
// 原AB正方向（DIR_REVERSE=0）:
//
//      00
//       ↓
//      01
//       ↓
//      11
//       ↓
//      10
//       ↓
//      00
//
// 每发生一次有效跳变:
// position_cnt + COUNT_STEP；DIR_REVERSE=1时计数方向相反
//
// 反方向则:
// position_cnt - COUNT_STEP
//
// ============================================================

always @(posedge clk)
begin

    if (!rst_n)
    begin

        position_cnt    <= 32'sd0;
        encoder_ab_last <= 2'b00;

    end

    else
    begin

        // 保存当前AB状态
        encoder_ab_last <= encoder_ab;


        // ============================================
        // 位置单独清零
        // ============================================

        if (position_zero)
        begin

            position_cnt <= 32'sd0;

        end

        else
        begin

            case ({
                encoder_ab_last,
                encoder_ab
            })


                // ====================================
                // 正方向
                // ====================================

                4'b0001,
                4'b0111,
                4'b1110,
                4'b1000:
                begin

                    position_cnt <= position_cnt + COUNT_STEP;

                end


                // ====================================
                // 反方向
                // ====================================

                4'b0010,
                4'b1011,
                4'b1101,
                4'b0100:
                begin

                    position_cnt <= position_cnt - COUNT_STEP;

                end


                // ====================================
                // 无变化或非法跳变
                // ====================================

                default:
                begin

                    position_cnt <= position_cnt;

                end

            endcase

        end

    end

end


endmodule
